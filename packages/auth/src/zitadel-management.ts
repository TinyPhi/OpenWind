import { request as nodeHttpRequest } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

// Moved here (from apps/api/src/lib/zitadel-management.ts) so both apps/api
// and apps/worker can reach it — apps/* may only depend on packages/*, never
// on another app, and the notification hub's outbound-handoff worker
// (apps/worker) needs getUserById to resolve a recipient's email. apps/api's
// old path now just re-exports from here, so its existing call sites and
// test mocks (which vi.mock the "../../lib/zitadel-management.js" path) are
// unaffected.

// ── Types ─────────────────────────────────────────────────────────────────────

const ServiceAccountKeySchema = z.object({
  type: z.string(),
  keyId: z.string(),
  key: z.string(),
  userId: z.string(),
  expirationDate: z.string().optional(),
});

export type ServiceAccountKey = z.infer<typeof ServiceAccountKeySchema>;

interface ZitadelRole {
  key: string;
  displayName: string;
  group: string;
}

export interface OrgUser {
  userId: string;
  email: string;
  displayName: string;
  loginName: string;
  /** E.164 phone number from Zitadel's human.phone.phone, if set. */
  phone: string | undefined;
}

// docs/specs/org-directory.md §C "metadata key contract" -- exactly these three
// keys, case-sensitive. Any other/misspelled metadata key on the user is
// ignored. `title` (job title) joined this list during PR3 implementation --
// Zitadel's human profile has no native job-title field, so it's read as
// metadata for the same reason department is: free text, sync-time only.
const ORG_METADATA_KEYS = ["manager_id", "department", "title"] as const;

export interface OrgMetadata {
  managerId: string | null;
  department: string | null;
  title: string | null;
}

interface ZitadelMetadataEntry {
  key: string;
  // Zitadel returns metadata values base64-encoded.
  value: string;
}

// Exported (pure, no network) so the key-filtering/base64-decode contract can be unit
// tested directly, without mocking node:http for the surrounding request plumbing.
export function parseOrgMetadataEntries(
  entries: ZitadelMetadataEntry[],
): OrgMetadata {
  const byKey = new Map<string, string>();
  for (const entry of entries) {
    if (
      !ORG_METADATA_KEYS.includes(
        entry.key as (typeof ORG_METADATA_KEYS)[number],
      )
    )
      continue;
    byKey.set(entry.key, Buffer.from(entry.value, "base64").toString("utf8"));
  }
  return {
    managerId: byKey.get("manager_id") ?? null,
    department: byKey.get("department") ?? null,
    title: byKey.get("title") ?? null,
  };
}

// ── Token cache ───────────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

// ── Role / user cache ─────────────────────────────────────────────────────────

let _cachedRoles: string[] | null = null;
let _rolesExpiresAt = 0;
interface UserCacheEntry {
  users: OrgUser[];
  expiresAt: number;
}
// Values may be a settled entry or an in-flight Promise (single-flight guard).
const _usersCache = new Map<string, UserCacheEntry | Promise<OrgUser[]>>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── URL helpers ───────────────────────────────────────────────────────────────
//
// ZITADEL_ISSUER is http://localhost:8080 (what the browser sees / JWT iss claim).
// Inside Docker the backend container must reach Zitadel via the Docker service name.
// We derive the internal base URL from ZITADEL_INTROSPECTION_URL which is already
// set to http://zitadel:8080/... in docker-compose — no extra env var needed.

function internalBase(): string {
  try {
    return new URL(env.ZITADEL_INTROSPECTION_URL).origin;
  } catch {
    return env.ZITADEL_ISSUER;
  }
}

function issuerHost(): string {
  try {
    return new URL(env.ZITADEL_ISSUER).hostname;
  } catch {
    return "localhost";
  }
}

// ── node:http helpers (allows custom Host header — fetch forbids it) ───────────

function httpPost(
  url: string,
  host: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const requestFn = isHttps ? nodeHttpsRequest : nodeHttpRequest;
    const buf = Buffer.from(body, "utf8");
    const req = requestFn(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          ...headers,
          Host: host,
          "Content-Length": buf.length.toString(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

function httpGet(
  url: string,
  host: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const requestFn = isHttps ? nodeHttpsRequest : nodeHttpRequest;
    const req = requestFn(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : isHttps ? 443 : 80,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          ...headers,
          Host: host,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

let _discoveredIssuer: string | null = null;

async function discoverIssuer(): Promise<string> {
  if (_discoveredIssuer) return _discoveredIssuer;
  try {
    const url = `${internalBase()}/.well-known/openid-configuration`;
    const res = await httpGet(url, issuerHost(), {});
    if (res.status === 200) {
      const data = JSON.parse(res.text) as { issuer: string };
      if (data.issuer) {
        _discoveredIssuer = data.issuer;
        return _discoveredIssuer;
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      "Failed to discover Zitadel issuer dynamically, falling back to ZITADEL_ISSUER",
    );
  }
  return env.ZITADEL_ISSUER;
}

// ── Parse service account key ─────────────────────────────────────────────────
// Tries ZITADEL_SERVICE_ACCOUNT_KEY (raw JSON) first, then ZITADEL_KEY_JSON
// (base64-encoded JSON written by bootstrap).

function parseServiceAccountKey(): ServiceAccountKey | null {
  const rawDirect = env.ZITADEL_SERVICE_ACCOUNT_KEY;
  const rawB64 = env.ZITADEL_KEY_JSON;
  const raw =
    rawDirect ??
    (rawB64 ? Buffer.from(rawB64, "base64").toString("utf8") : undefined);
  if (!raw) return null;

  try {
    return ServiceAccountKeySchema.parse(JSON.parse(raw));
  } catch {
    logger.error(
      { keyConfigured: !!raw },
      "Failed to parse service account key — invalid JSON or missing fields",
    );
    return null;
  }
}

/**
 * T4 (docs/specs/multi-org-sandbox.md, ADR-022) -- the sandbox-provisioning credential,
 * deliberately separate from parseServiceAccountKey() above (which backs every
 * read-oriented Management API call in this file: listOrgUsers, listUserRolesByUserId,
 * getOrgMetadataForUser, etc). Provisioning needs to CREATE orgs and human users, a strictly
 * more dangerous capability than the read-only calls the other key is used for -- a
 * compromise or bug in one credential's usage should not carry the other's scope for free.
 *
 * This function only parses the key; it does not yet exchange it for an access token or
 * cache one (unlike getAccessToken above) -- that lives with Phase 2's T7 provisioning job,
 * the first and only caller. Returns null (never throws) the same way
 * parseServiceAccountKey does, so a missing/misconfigured credential surfaces as "cannot
 * provision" rather than crashing whatever process checks for it.
 */
export function parseProvisioningServiceAccountKey(): ServiceAccountKey | null {
  const rawDirect = env.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY;
  const rawB64 = env.ZITADEL_PROVISIONING_KEY_JSON;
  const raw =
    rawDirect ??
    (rawB64 ? Buffer.from(rawB64, "base64").toString("utf8") : undefined);
  if (!raw) return null;

  try {
    return ServiceAccountKeySchema.parse(JSON.parse(raw));
  } catch {
    logger.error(
      { keyConfigured: !!raw },
      "Failed to parse provisioning service account key — invalid JSON or missing fields",
    );
    return null;
  }
}

// ── Get access token (JWT bearer → OAuth token exchange) ──────────────────────

async function getAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 30_000) return _cachedToken;

  const keyConfig = parseServiceAccountKey();
  if (!keyConfig) return null;

  try {
    // Zitadel may return PKCS#1 ("BEGIN RSA PRIVATE KEY") or PKCS#8 ("BEGIN PRIVATE KEY").
    // importPKCS8 only handles PKCS#8 — normalise via Node's createPrivateKey which accepts both.
    const exportedKey = keyConfig.key.includes("BEGIN PRIVATE KEY")
      ? keyConfig.key
      : createPrivateKey(keyConfig.key).export({
          type: "pkcs8",
          format: "pem",
        });
    // exportedKey is string when input is already PKCS#8, Buffer otherwise
    const keyPem =
      typeof exportedKey === "string"
        ? exportedKey
        : (exportedKey as Buffer).toString("utf8");
    const issuer = await discoverIssuer();
    const privateKey = await importPKCS8(keyPem, "RS256");
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: keyConfig.keyId })
      .setIssuedAt()
      .setIssuer(keyConfig.userId)
      .setSubject(keyConfig.userId)
      .setAudience(issuer)
      .setExpirationTime("1h")
      .sign(privateKey);

    // Use internal Docker URL for the token exchange; send Host matching EXTERNALDOMAIN
    const tokenUrl = `${internalBase()}/oauth/v2/token`;
    logger.info(
      { tokenUrl, issuer, keyUserId: keyConfig.userId },
      "getAccessToken: exchanging service account JWT",
    );
    const result = await httpPost(
      tokenUrl,
      issuerHost(),
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope:
          "openid profile email urn:zitadel:iam:org:project:id:zitadel:aud",
        assertion,
      }).toString(),
    );

    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- it's an unvetted external payload
      // that may carry provider-specific diagnostic detail we don't control.
      logger.error({ status: result.status }, "Zitadel token exchange failed");
      return null;
    }

    const data = JSON.parse(result.text) as {
      access_token: string;
      expires_in: number;
    };
    _cachedToken = data.access_token;
    _tokenExpiresAt = now + data.expires_in * 1000;
    return _cachedToken;
  } catch (err) {
    logger.error({ err }, "Failed to obtain Zitadel service account token");
    return null;
  }
}

// ── Get provisioning access token (T7) ──────────────────────────────────────────
// Deliberately its own cache, separate from getAccessToken's — the provisioning
// credential (parseProvisioningServiceAccountKey) is a strictly more dangerous scope
// (can CREATE orgs/users) than the read-only one, so a bug in one token's caching must
// never bleed into the other's lifetime.

let _cachedProvisioningToken: string | null = null;
let _provisioningTokenExpiresAt = 0;

async function getProvisioningAccessToken(): Promise<string | null> {
  const now = Date.now();
  if (_cachedProvisioningToken && now < _provisioningTokenExpiresAt - 30_000)
    return _cachedProvisioningToken;

  const keyConfig = parseProvisioningServiceAccountKey();
  if (!keyConfig) return null;

  try {
    const exportedKey = keyConfig.key.includes("BEGIN PRIVATE KEY")
      ? keyConfig.key
      : createPrivateKey(keyConfig.key).export({
          type: "pkcs8",
          format: "pem",
        });
    const keyPem =
      typeof exportedKey === "string"
        ? exportedKey
        : (exportedKey as Buffer).toString("utf8");
    const issuer = await discoverIssuer();
    const privateKey = await importPKCS8(keyPem, "RS256");
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: keyConfig.keyId })
      .setIssuedAt()
      .setIssuer(keyConfig.userId)
      .setSubject(keyConfig.userId)
      .setAudience(issuer)
      .setExpirationTime("1h")
      .sign(privateKey);

    const tokenUrl = `${internalBase()}/oauth/v2/token`;
    const result = await httpPost(
      tokenUrl,
      issuerHost(),
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        scope:
          "openid profile email urn:zitadel:iam:org:project:id:zitadel:aud",
        assertion,
      }).toString(),
    );

    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- it's an unvetted external payload.
      logger.error(
        { status: result.status },
        "Zitadel provisioning token exchange failed",
      );
      return null;
    }

    const data = JSON.parse(result.text) as {
      access_token: string;
      expires_in: number;
    };
    _cachedProvisioningToken = data.access_token;
    _provisioningTokenExpiresAt = now + data.expires_in * 1000;
    return _cachedProvisioningToken;
  } catch (err) {
    logger.error(
      { err },
      "Failed to obtain Zitadel provisioning service account token",
    );
    return null;
  }
}

// ── Create org / human user (T7) ─────────────────────────────────────────────────
// Both use the provisioning credential above, never the read-only one. Zitadel org
// uniqueness is instance-wide for the org name and per-org for usernames/emails -- an
// "already exists"/"already taken" response is surfaced as a typed conflict so T7's
// provisioning job can retry with a fresh candidate from sandbox-org-template.ts,
// rather than this function retrying internally (the caller owns the retry budget and
// the candidate generation, this function only reports what happened).
//
// isConflictResponse checks both the plain REST 409 and Zitadel's own gRPC-gateway
// error shape (`code: 6` / FailedPrecondition, or an AlreadyExists message), since T5's
// password-policy spike (still open) hasn't confirmed which shape this instance
// actually returns for a uniqueness collision on the v2 API -- treating either as a
// conflict is the safer default: worst case is an extra, harmless retry with a fresh
// candidate, whereas under-detecting a conflict would surface a real collision as a
// hard failure instead of a retry.
function isConflictResponse(status: number, text: string): boolean {
  if (status === 409) return true;
  if (status < 400 || status >= 500) return false;
  try {
    const body = JSON.parse(text) as { code?: number; message?: string };
    if (body.code === 6) return true;
    if (
      typeof body.message === "string" &&
      /already ?exists/i.test(body.message)
    )
      return true;
  } catch {
    // Non-JSON body -- fall through to "not a conflict".
  }
  return false;
}

export interface CreateOrgResult {
  ok: true;
  orgId: string;
}
export interface CreateOrgConflict {
  ok: false;
  conflict: true;
}
export interface CreateOrgFailure {
  ok: false;
  conflict: false;
}

export async function createOrg(
  name: string,
): Promise<CreateOrgResult | CreateOrgConflict | CreateOrgFailure> {
  const token = await getProvisioningAccessToken();
  if (!token) return { ok: false, conflict: false };

  try {
    const url = `${internalBase()}/v2/organizations`;
    const result = await httpPost(
      url,
      issuerHost(),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ name }),
    );

    if (isConflictResponse(result.status, result.text))
      return { ok: false, conflict: true };
    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- see comment in getAccessToken.
      logger.error(
        { status: result.status, name },
        "createOrg: Zitadel org creation failed",
      );
      return { ok: false, conflict: false };
    }

    const data = JSON.parse(result.text) as { organizationId?: string };
    if (!data.organizationId) return { ok: false, conflict: false };
    return { ok: true, orgId: data.organizationId };
  } catch (err) {
    logger.error({ err, name }, "Failed to create Zitadel organization");
    return { ok: false, conflict: false };
  }
}

export interface CreateHumanUserInput {
  orgId: string;
  email: string;
  givenName: string;
  familyName: string;
  password: string;
}

export interface CreateHumanUserResult {
  ok: true;
  userId: string;
}
export interface CreateHumanUserConflict {
  ok: false;
  conflict: true;
}
export interface CreateHumanUserFailure {
  ok: false;
  conflict: false;
}

/**
 * isEmailVerified: true, changeRequired: false -- R3's revised criterion (2026-10-07):
 * seeded accounts are never forced through a password-change screen, since most of them
 * exist only to populate the org chart and are never logged into.
 */
export async function createHumanUser(
  input: CreateHumanUserInput,
): Promise<
  CreateHumanUserResult | CreateHumanUserConflict | CreateHumanUserFailure
> {
  const token = await getProvisioningAccessToken();
  if (!token) return { ok: false, conflict: false };

  try {
    const url = `${internalBase()}/v2/users/human`;
    const payload = {
      organization: { orgId: input.orgId },
      profile: {
        givenName: input.givenName,
        familyName: input.familyName,
      },
      email: { email: input.email, isVerified: true },
      password: { password: input.password, changeRequired: false },
    };
    const result = await httpPost(
      url,
      issuerHost(),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify(payload),
    );

    if (isConflictResponse(result.status, result.text))
      return { ok: false, conflict: true };
    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- see comment in getAccessToken.
      logger.error(
        { status: result.status, orgId: input.orgId },
        "createHumanUser: Zitadel user creation failed",
      );
      return { ok: false, conflict: false };
    }

    const data = JSON.parse(result.text) as { userId?: string };
    if (!data.userId) return { ok: false, conflict: false };
    return { ok: true, userId: data.userId };
  } catch (err) {
    logger.error(
      { err, orgId: input.orgId },
      "Failed to create Zitadel human user",
    );
    return { ok: false, conflict: false };
  }
}

// ── List project roles ────────────────────────────────────────────────────────

export async function listProjectRoles(): Promise<string[]> {
  const now = Date.now();
  if (_cachedRoles && now < _rolesExpiresAt) return _cachedRoles;

  const token = await getAccessToken();
  if (!token) return [];

  const projectId = env.ZITADEL_PROJECT_ID ?? env.ZITADEL_AUDIENCE;
  if (!projectId) return [];

  try {
    const url = `${internalBase()}/management/v1/projects/${projectId}/roles/_search`;
    const result = await httpPost(
      url,
      issuerHost(),
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ limit: 200 }),
    );

    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- see comment in getAccessToken.
      logger.error({ status: result.status }, "Zitadel list roles failed");
      return [];
    }

    const data = JSON.parse(result.text) as { result?: ZitadelRole[] };
    const roles = (data.result ?? []).map((r) => r.key);
    _cachedRoles = roles;
    _rolesExpiresAt = now + CACHE_TTL_MS;
    return roles;
  } catch (err) {
    logger.error({ err }, "Failed to list Zitadel project roles");
    return [];
  }
}

// ── List org users ────────────────────────────────────────────────────────────

// orgId is required (not optional) — callers must guard at the call site
// (`orgId ? listOrgUsers(orgId) : Promise.resolve([])`) rather than this
// function silently falling through to an unfiltered instance-wide query on a
// missing orgId. Also guards against a shared cache entry across tenants (see
// security review — listOrgUsers previously had a "_default_" fallback cache
// key that any org with a missing orgId shared).
export async function listOrgUsers(orgId: string): Promise<OrgUser[]> {
  // Runtime guard alongside the compile-time non-optional type — a caller
  // that bypasses TypeScript (e.g. an untyped/JS call site) must still fail
  // closed here rather than falling through to a cache lookup keyed on
  // undefined/"" and an unrelated getAccessToken failure path.
  if (!orgId) {
    logger.warn(
      {},
      "listOrgUsers called without an orgId — refusing to fall through to an unfiltered query",
    );
    return [];
  }

  const cacheKey = orgId;
  const now = Date.now();
  const cached = _usersCache.get(cacheKey);
  // Return settled cache entry if still fresh
  if (cached && !(cached instanceof Promise) && now < cached.expiresAt)
    return cached.users;
  // Return in-flight promise if another caller already started the fetch
  if (cached instanceof Promise) return cached;

  const pending = _fetchOrgUsers(orgId, now, cacheKey);
  _usersCache.set(cacheKey, pending);
  return pending;
}

async function _fetchOrgUsers(
  orgId: string,
  now: number,
  cacheKey: string,
): Promise<OrgUser[]> {
  const token = await getAccessToken();
  if (!token) {
    logger.warn(
      { orgId },
      "listOrgUsers: no service account token — check ZITADEL_SERVICE_ACCOUNT_KEY",
    );
    return [];
  }

  try {
    // Use v2 UserService endpoint (gRPC-gateway) — returns active human users in the org
    const url = `${internalBase()}/zitadel.user.v2.UserService/ListUsers`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const PAGE_LIMIT = 500;
    const payload: Record<string, unknown> = {
      query: { limit: PAGE_LIMIT, asc: true },
      queries: [{ organizationIdQuery: { organizationId: orgId } }],
    };

    const result = await httpPost(
      url,
      issuerHost(),
      headers,
      JSON.stringify(payload),
    );

    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- see comment in getAccessToken.
      logger.warn({ status: result.status }, "Zitadel list users failed");
      return [];
    }

    interface ZitadelUser {
      userId: string;
      username?: string;
      preferredLoginName?: string;
      loginNames?: string[];
      state?: string;
      human?: {
        profile?: {
          displayName?: string;
          givenName?: string;
          familyName?: string;
        };
        email?: { email?: string };
        phone?: { phone?: string };
      };
    }

    const data = JSON.parse(result.text) as {
      result?: ZitadelUser[];
      details?: { totalResult?: string };
    };
    const totalResult = parseInt(data.details?.totalResult ?? "0", 10);
    if (totalResult > PAGE_LIMIT) {
      logger.warn(
        { orgId, totalResult, fetched: PAGE_LIMIT },
        "listOrgUsers: result truncated — total exceeds page limit",
      );
    }
    const users: OrgUser[] = (data.result ?? [])
      .filter((u) => u.human !== undefined && u.state === "USER_STATE_ACTIVE")
      .map((u) => {
        const profile = u.human?.profile ?? {};
        const nameParts = [profile.givenName, profile.familyName].filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        );
        const fullName = nameParts.length > 0 ? nameParts.join(" ") : undefined;
        const displayName =
          profile.displayName ?? fullName ?? u.preferredLoginName ?? u.userId;
        const loginName = u.preferredLoginName ?? u.loginNames?.[0] ?? u.userId;
        return {
          userId: u.userId,
          email: u.human?.email?.email ?? "",
          displayName,
          loginName,
          phone: u.human?.phone?.phone,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    _usersCache.set(orgId, { users, expiresAt: now + CACHE_TTL_MS });
    return users;
  } catch (err) {
    logger.error({ err }, "Failed to list Zitadel org users");
    // Evict so the next caller retries rather than getting a rejected/hung promise.
    _usersCache.delete(cacheKey);
    return [];
  }
}

// ── List each org user's project role grants ────────────────────────────────
//
// Used to (a) filter the org-wide user list down to a single role (e.g. "user")
// for surfaces that must never expose agents/admins — the users page and the
// @mention picker — and (b) render each user's role(s) in the users page's
// Roles column. Queries Zitadel's user-grant search rather than trusting the
// caller's own JWT roles claim, since this lists *other* users' roles.

const _userRolesCache = new Map<
  string,
  | { rolesByUserId: Map<string, string[]>; expiresAt: number }
  | Promise<Map<string, string[]>>
>();

export async function listUserRolesByUserId(
  orgId: string,
): Promise<Map<string, string[]>> {
  if (!orgId) return new Map();

  const cacheKey = orgId;
  const now = Date.now();
  const cached = _userRolesCache.get(cacheKey);
  if (cached && !(cached instanceof Promise) && now < cached.expiresAt)
    return cached.rolesByUserId;
  if (cached instanceof Promise) return cached;

  const pending = _fetchUserRolesByUserId(orgId, now, cacheKey);
  _userRolesCache.set(cacheKey, pending);
  return pending;
}

export async function listUserIdsWithRole(
  orgId: string,
  roleKey: string,
): Promise<Set<string>> {
  const rolesByUserId = await listUserRolesByUserId(orgId);
  const userIds = new Set<string>();
  for (const [userId, roles] of rolesByUserId) {
    if (roles.includes(roleKey)) userIds.add(userId);
  }
  return userIds;
}

async function _fetchUserRolesByUserId(
  orgId: string,
  now: number,
  cacheKey: string,
): Promise<Map<string, string[]>> {
  const token = await getAccessToken();
  if (!token) {
    logger.warn(
      { orgId },
      "listUserRolesByUserId: no service account token — check ZITADEL_SERVICE_ACCOUNT_KEY",
    );
    return new Map();
  }

  const projectId = env.ZITADEL_PROJECT_ID ?? env.ZITADEL_AUDIENCE;
  if (!projectId) return new Map();

  try {
    const url = `${internalBase()}/management/v1/users/grants/_search`;
    const PAGE_LIMIT = 1000;
    const payload = {
      query: { limit: PAGE_LIMIT, asc: true },
      queries: [{ projectIdQuery: { projectId } }],
    };

    const result = await httpPost(
      url,
      issuerHost(),
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      JSON.stringify(payload),
    );

    if (result.status < 200 || result.status >= 300) {
      logger.error(
        { status: result.status },
        "listUserRolesByUserId: Zitadel grants search failed",
      );
      _userRolesCache.delete(cacheKey);
      return new Map();
    }

    const data = JSON.parse(result.text) as {
      result?: Array<{ userId: string; roleKeys?: string[] }>;
      details?: { totalResult?: string };
    };
    const totalResult = parseInt(data.details?.totalResult ?? "0", 10);
    if (totalResult > PAGE_LIMIT) {
      logger.warn(
        { orgId, totalResult, fetched: PAGE_LIMIT },
        "listUserRolesByUserId: result truncated — total exceeds page limit",
      );
    }

    const rolesByUserId = new Map<string, string[]>();
    for (const grant of data.result ?? []) {
      const existing = rolesByUserId.get(grant.userId) ?? [];
      rolesByUserId.set(
        grant.userId,
        Array.from(new Set([...existing, ...(grant.roleKeys ?? [])])),
      );
    }
    _userRolesCache.set(cacheKey, {
      rolesByUserId,
      expiresAt: now + CACHE_TTL_MS,
    });
    return rolesByUserId;
  } catch (err) {
    logger.error({ err }, "Failed to list Zitadel user grants");
    _userRolesCache.delete(cacheKey);
    return new Map();
  }
}

// ── Get single user by ID ─────────────────────────────────────────────────────

const _userByIdCache = new Map<
  string,
  { user: OrgUser | null; expiresAt: number }
>();

export async function getUserById(userId: string): Promise<OrgUser | null> {
  const now = Date.now();
  const cached = _userByIdCache.get(userId);
  if (cached && now < cached.expiresAt) return cached.user;

  const token = await getAccessToken();
  if (!token) return null;

  try {
    const url = `${internalBase()}/zitadel.user.v2.UserService/GetUserByID`;
    const result = await httpPost(
      url,
      issuerHost(),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ userId }),
    );

    if (result.status < 200 || result.status >= 300) return null;

    interface ZitadelGetUserResponse {
      user?: {
        userId: string;
        preferredLoginName?: string;
        loginNames?: string[];
        human?: {
          profile?: {
            displayName?: string;
            givenName?: string;
            familyName?: string;
          };
          email?: { email?: string };
          phone?: { phone?: string };
        };
      };
    }

    const data = JSON.parse(result.text) as ZitadelGetUserResponse;
    const u = data.user;
    if (!u) {
      _userByIdCache.set(userId, { user: null, expiresAt: now + CACHE_TTL_MS });
      return null;
    }

    const profile = u.human?.profile ?? {};
    const nameParts = [profile.givenName, profile.familyName].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    const fullName = nameParts.length > 0 ? nameParts.join(" ") : undefined;
    const displayName =
      profile.displayName ?? fullName ?? u.preferredLoginName ?? u.userId;
    const loginName = u.preferredLoginName ?? u.loginNames?.[0] ?? u.userId;
    const orgUser: OrgUser = {
      userId: u.userId,
      email: u.human?.email?.email ?? "",
      displayName,
      loginName,
      phone: u.human?.phone?.phone,
    };
    _userByIdCache.set(userId, {
      user: orgUser,
      expiresAt: now + CACHE_TTL_MS,
    });
    return orgUser;
  } catch {
    return null;
  }
}

// ── Get org-directory metadata (manager_id / department) for a user ────────────
//
// docs/specs/org-directory.md T2 -- read-only primitive the org-directory importer
// (packages/org-directory) calls once per user during a sync. Deliberately separate
// from getUserById's identity fields: metadata is a distinct Zitadel API surface
// (user.v2.UserService/ListMetadata) and callers that don't care about org-directory
// shouldn't pay for an extra request.

const _orgMetadataCache = new Map<
  string,
  { data: OrgMetadata; expiresAt: number } | Promise<OrgMetadata>
>();

export async function getOrgMetadataForUser(
  userId: string,
): Promise<OrgMetadata> {
  const now = Date.now();
  const cached = _orgMetadataCache.get(userId);
  if (cached && !(cached instanceof Promise) && now < cached.expiresAt)
    return cached.data;
  if (cached instanceof Promise) return cached;

  const pending = _fetchOrgMetadataForUser(userId);
  _orgMetadataCache.set(userId, pending);
  return pending;
}

async function _fetchOrgMetadataForUser(userId: string): Promise<OrgMetadata> {
  const empty: OrgMetadata = { managerId: null, department: null, title: null };
  const token = await getAccessToken();
  if (!token) {
    logger.warn(
      { userId },
      "getOrgMetadataForUser: no service account token — check ZITADEL_SERVICE_ACCOUNT_KEY",
    );
    // Evict rather than leaving the resolved (empty) promise cached — otherwise a
    // transient missing token permanently poisons this user's lookups until an
    // unrelated invalidateUserCache() call, since a resolved Promise still reads
    // as "cached" to callers.
    _orgMetadataCache.delete(userId);
    return empty;
  }

  try {
    const url = `${internalBase()}/zitadel.user.v2.UserService/ListMetadata`;
    const result = await httpPost(
      url,
      issuerHost(),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ userId }),
    );

    if (result.status < 200 || result.status >= 300) {
      // Never log the raw response body -- see comment in getAccessToken.
      logger.warn(
        { status: result.status, userId },
        "getOrgMetadataForUser: Zitadel list metadata failed",
      );
      _orgMetadataCache.delete(userId);
      return empty;
    }

    const data = JSON.parse(result.text) as {
      metadata?: ZitadelMetadataEntry[];
    };
    const orgMetadata = parseOrgMetadataEntries(data.metadata ?? []);
    // TTL measured from completion, not from `now` captured before the round-trip --
    // otherwise request latency silently shrinks the effective cache lifetime.
    _orgMetadataCache.set(userId, {
      data: orgMetadata,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return orgMetadata;
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch Zitadel user org metadata");
    _orgMetadataCache.delete(userId);
    return empty;
  }
}

export async function deleteUser(userId: string): Promise<boolean> {
  const token = await getAccessToken();
  if (!token) return false;

  try {
    const url = `${internalBase()}/zitadel.user.v2.UserService/DeleteUser`;
    const result = await httpPost(
      url,
      issuerHost(),
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      JSON.stringify({ userId }),
    );
    return result.status >= 200 && result.status < 300;
  } catch (err) {
    logger.error({ err, userId }, "Failed to delete Zitadel user");
    return false;
  }
}

// ── Cache invalidation ────────────────────────────────────────────────────────

export function invalidateUserCache(): void {
  _usersCache.clear();
  _userByIdCache.clear();
  _userRolesCache.clear();
  _orgMetadataCache.clear();
}
