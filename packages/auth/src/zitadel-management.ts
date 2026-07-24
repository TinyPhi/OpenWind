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

type ServiceAccountKey = z.infer<typeof ServiceAccountKeySchema>;

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

// ── Cache invalidation ────────────────────────────────────────────────────────

export function invalidateUserCache(): void {
  _usersCache.clear();
  _userByIdCache.clear();
}
