import { createMiddleware } from "hono/factory";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { Context, Next, MiddlewareHandler } from "hono";
import { env } from "@platform/config";
import type { DbOrTx } from "@platform/db";
import {
  db,
  apiKeys,
  tenants,
  tenantUsers,
  withTenantContext,
} from "@platform/db";
import { logger } from "@platform/logger";
import { getRedis, checkRateLimit } from "@platform/redis";
import { verifyJwt, extractAuthContext } from "./jwks.js";
import { introspectToken } from "./introspection.js";
import type { AuthContext } from "./types.js";
import {
  getCachedTenantStatus,
  setCachedTenantStatus,
} from "./tenant-status-cache.js";

const TENANT_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Post-auth, tenant-scoped rate limit (#195). Runs only after the JWT/API-key
 * has been verified, so unlike the pre-auth IP-based stage (apps/api's
 * rate-limit middleware), the key here is unforgeable — a client cannot get
 * a fresh bucket by varying an unverified claim. Returns a 429 Response when
 * exceeded, or null to let the caller proceed.
 *
 * checkRateLimit itself already fails open (bounded timeout, never throws —
 * see packages/redis/src/rate-limit.ts). The try/catch here is a second,
 * independent layer: this runs on every authenticated request across the
 * whole API, so if that contract were ever violated by a future change, the
 * failure mode must still be "request proceeds," never "500s the entire API."
 */
async function enforceTenantRateLimit(
  c: Context<AuthVariables>,
  tenantId: string,
): Promise<Response | null> {
  try {
    const { allowed, remaining, resetAt } = await checkRateLimit(
      getRedis(),
      `rl:tenant:${tenantId}`,
      env.RATE_LIMIT_TENANT_PER_MIN,
      TENANT_RATE_LIMIT_WINDOW_SECONDS,
    );

    c.header("x-ratelimit-limit", String(env.RATE_LIMIT_TENANT_PER_MIN));
    c.header("x-ratelimit-remaining", String(remaining));
    c.header("x-ratelimit-reset", String(resetAt));

    if (!allowed) {
      return c.json(
        { error: "RATE_LIMITED", message: "Too many requests" },
        429,
      );
    }
    return null;
  } catch (err) {
    logger.warn(
      { err, tenantId },
      "auth: tenant rate-limit check failed unexpectedly — failing open",
    );
    return null;
  }
}

type AuthVariables = { Variables: { auth: AuthContext } };

// In-process cache for fetchUserInfo, keyed by a hash of the bearer token
// (never the raw token — mirrors introspection.ts's SHA-256 cache-key
// pattern). Without this, an identity whose JWT never carries email/name
// (e.g. an instance admin or pre-profile-scope token) triggered a fresh
// Zitadel userinfo call on every single request indefinitely. The pending
// map additionally dedups concurrent callers so a burst of requests from the
// same claims-missing identity shares one in-flight fetch instead of firing
// N of them.
const USERINFO_CACHE_TTL_MS = 60_000;
const _userInfoCache = new Map<
  string,
  { info: { name: string | null; email: string | null } | null; exp: number }
>();
const _userInfoPending = new Map<
  string,
  Promise<{ name: string | null; email: string | null } | null>
>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Calls /oidc/v1/userinfo with the user's own access token.
// Returns enriched name/email when the JWT itself is missing profile claims
// (e.g. instance admins, machine users, or tokens issued before token settings were updated).
async function fetchUserInfo(
  bearerToken: string,
): Promise<{ name: string | null; email: string | null } | null> {
  const key = hashToken(bearerToken);

  const cached = _userInfoCache.get(key);
  if (cached && Date.now() < cached.exp) return cached.info;

  const pending = _userInfoPending.get(key);
  if (pending) return pending;

  const request = (async () => {
    try {
      const url = `${env.ZITADEL_ISSUER}/oidc/v1/userinfo`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      return {
        name: typeof data["name"] === "string" ? data["name"] : null,
        email: typeof data["email"] === "string" ? data["email"] : null,
      };
    } catch {
      return null;
    }
  })().then((info) => {
    _userInfoCache.set(key, { info, exp: Date.now() + USERINFO_CACHE_TTL_MS });
    return info;
  });

  _userInfoPending.set(key, request);
  try {
    return await request;
  } finally {
    _userInfoPending.delete(key);
  }
}

/**
 * requireAuth — validates Bearer JWT (Zitadel JWKS) or API key (sk_... prefix).
 *
 * JWT path: verifies signature, extracts tenantId from org claim, roles from project claims.
 * API key path: hashes the raw key, looks up in api_keys table, loads tenant from key row.
 *
 * The `db` parameter is only needed for API key validation.  Passing `undefined`
 * (or calling `requireAuth()` with no argument) intentionally restricts the route
 * to JWT tokens only — any `sk_…` API key presented will be rejected with 401.
 * Use this on routes where API key access is explicitly not permitted.
 */
export const requireAuth = (db?: DbOrTx): MiddlewareHandler =>
  createMiddleware<AuthVariables>(
    async (c: Context<AuthVariables>, next: Next): Promise<Response | void> => {
      // Short-circuit when auth has been pre-populated (e.g. by test fixtures
      // or an upstream gateway that already verified the token).
      // Hono's Variables type marks auth as non-optional (it's always present
      // after requireAuth runs), but here we ARE the setter — at call time it
      // may genuinely be absent.  The condition is necessary at runtime even
      // though TypeScript's static view sees it as always-truthy.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (c.get("auth")) {
        await next();
        return;
      }

      const authHeader = c.req.header("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ error: "UNAUTHORIZED", message: "Missing token" }, 401);
      }

      const token = authHeader.slice(7);

      // API key: sk_ prefix
      if (token.startsWith("sk_")) {
        if (!db) {
          logger.warn(
            {},
            "API key presented but no db handle provided to requireAuth",
          );
          return c.json(
            { error: "UNAUTHORIZED", message: "Invalid token" },
            401,
          );
        }
        const auth = await resolveApiKey(db, token);
        if (!auth) {
          return c.json(
            { error: "UNAUTHORIZED", message: "Invalid API key" },
            401,
          );
        }
        const apiKeyTenantStatus = await resolveTenantStatus(auth.tenantId, db);
        if (apiKeyTenantStatus === "suspended") {
          return c.json(
            {
              error: "TENANT_SUSPENDED",
              message:
                "This account has been suspended. Please contact support.",
            },
            403,
          );
        }
        if (
          apiKeyTenantStatus === "deleted" ||
          apiKeyTenantStatus === "purged"
        ) {
          return c.json(
            { error: "TENANT_NOT_FOUND", message: "Not found" },
            404,
          );
        }
        c.set("auth", auth);
        const rateLimited = await enforceTenantRateLimit(c, auth.tenantId);
        if (rateLimited) return rateLimited;
        await next();
        return;
      }

      // JWT path
      const claims = await verifyJwt(token);
      if (!claims) {
        return c.json({ error: "UNAUTHORIZED", message: "Invalid token" }, 401);
      }

      let auth = extractAuthContext(claims);
      if (!auth) {
        logger.warn(
          {
            sub: claims.sub,
            orgId:
              claims["urn:zitadel:iam:user:resourceowner:id"] ?? "(missing)",
          },
          "JWT missing required claims — sub or urn:zitadel:iam:user:resourceowner:id not present",
        );
        return c.json(
          { error: "UNAUTHORIZED", message: "Missing required claims" },
          401,
        );
      }

      // In production there is no DEV_TENANT_ID fallback (the Zod schema
      // forbids it), so extractAuthContext's tenantId is just the raw
      // Zitadel org id — never a valid `uuid`. Resolve the real tenant via
      // the zitadel_org_id mapping and fail closed if none exists, rather
      // than let a malformed tenantId reach any tenant-scoped query.
      // See docs/specs/tenant-org-id-mapping.md.
      if (env.NODE_ENV === "production") {
        const mappedTenantId = auth.orgId
          ? await lookupTenantIdByOrgId(auth.orgId, db)
          : null;
        if (!mappedTenantId) {
          logger.warn(
            { orgId: auth.orgId ?? "(missing)" },
            "No tenant mapped to this Zitadel org — rejecting",
          );
          return c.json(
            { error: "TENANT_NOT_FOUND", message: "Not found" },
            404,
          );
        }
        auth = { ...auth, tenantId: mappedTenantId };
      }

      // If JWT is missing email or name (e.g. instance admins, tokens issued before
      // "include profile info" was enabled), enrich from the userinfo endpoint.
      if (!auth.email || auth.displayName === auth.userId) {
        const info = await fetchUserInfo(token);
        if (info) {
          auth = {
            ...auth,
            email: info.email ?? auth.email,
            displayName: info.name ?? info.email ?? auth.displayName,
          };
        }
      }

      c.set("auth", auth);

      // Check that the tenant is active before proceeding.
      const tenantStatus = await resolveTenantStatus(auth.tenantId, db);
      if (tenantStatus === "suspended") {
        return c.json(
          {
            error: "TENANT_SUSPENDED",
            message: "This account has been suspended. Please contact support.",
          },
          403,
        );
      }
      if (tenantStatus === "deleted" || tenantStatus === "purged") {
        return c.json({ error: "TENANT_NOT_FOUND", message: "Not found" }, 404);
      }

      const rateLimited = await enforceTenantRateLimit(c, auth.tenantId);
      if (rateLimited) return rateLimited;

      // Upsert the verified user into tenant_users BEFORE calling next().
      // This must complete before the route handler runs so that
      // validateUserRefs() can find the user on their very first request
      // (fire-and-forget would race with the INSERT on a brand-new user).
      //
      // Why withTenantContext and not a plain db.insert()?
      // tenant_users has an RLS policy enforced via the `app.tenant_id` GUC
      // (see migration 0007).  Without withTenantContext setting that GUC,
      // the WITH CHECK clause evaluates to NULL and the INSERT is silently
      // rejected by Postgres RLS.
      //
      // (#124) Only insert/update when the row is missing or the profile
      // actually changed — on the steady-state request (existing user, no
      // profile change) this is a single indexed SELECT, not a write, so we
      // avoid a HOT row rewrite on every authenticated request.
      await withTenantContext(auth.tenantId, async (tx) => {
        const [existing] = await tx
          .select({
            email: tenantUsers.email,
            displayName: tenantUsers.displayName,
          })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.tenantId, auth.tenantId),
              eq(tenantUsers.userId, auth.userId),
            ),
          )
          .limit(1);

        const sanitizeDisplayName = (
          name: string | null | undefined,
        ): string | null => {
          if (!name) return null;
          return name.replace(/[<>]/g, "");
        };

        const nextEmail = auth.email || null;
        const nextDisplayName = sanitizeDisplayName(auth.displayName);

        if (
          existing?.email === nextEmail &&
          existing.displayName === nextDisplayName
        ) {
          return;
        }

        await tx
          .insert(tenantUsers)
          .values({
            tenantId: auth.tenantId,
            userId: auth.userId,
            email: nextEmail,
            displayName: nextDisplayName,
          })
          .onConflictDoUpdate({
            target: [tenantUsers.tenantId, tenantUsers.userId],
            set: {
              email: nextEmail,
              displayName: nextDisplayName,
            },
          });
      }).catch((err: unknown) => {
        logger.warn(
          { err, tenantId: auth.tenantId },
          "auth: failed to sync tenant user — user_ref validation may fail on this request",
        );
      });
      await next();
      return;
    },
  );

export const requireRole = (...roles: string[]): MiddlewareHandler =>
  createMiddleware<AuthVariables>(
    async (c: Context<AuthVariables>, next: Next): Promise<Response | void> => {
      const auth = c.get("auth");
      const hasRole = roles.some((r) => auth.roles.includes(r));
      if (!hasRole) {
        return c.json(
          { error: "FORBIDDEN", message: "Insufficient permissions" },
          403,
        );
      }
      await next();
      return;
    },
  );

/**
 * requireIntrospection — use on sensitive operations (e.g. tenant deletion,
 * permission changes). Calls Zitadel's token introspection endpoint rather than
 * relying solely on JWT signature verification. Result is cached for 60s.
 *
 * Must be placed AFTER requireAuth so that c.get("auth") is already populated.
 */
export const requireIntrospection = (): MiddlewareHandler =>
  createMiddleware<AuthVariables>(
    async (c: Context<AuthVariables>, next: Next): Promise<Response | void> => {
      const authHeader = c.req.header("Authorization");
      // Should always be present after requireAuth, but be defensive
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ error: "UNAUTHORIZED", message: "Missing token" }, 401);
      }

      const token = authHeader.slice(7);
      // API keys are not subject to introspection
      if (token.startsWith("sk_")) {
        await next();
        return;
      }

      const result = await introspectToken(token);
      if (!result.active) {
        return c.json(
          { error: "UNAUTHORIZED", message: "Token is not active" },
          401,
        );
      }

      await next();
      return;
    },
  );

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Return the tenant's current status, using a 30 s in-process cache.
 * The tenants table has no RLS, so we query with the plain db instance.
 * Returns "deleted" if the tenant row does not exist.
 */
async function resolveTenantStatus(
  tenantId: string,
  dbHandle?: DbOrTx,
): Promise<string> {
  const cached = getCachedTenantStatus(tenantId);
  if (cached !== undefined) return cached;

  const activeDb = dbHandle ?? db;
  const [row] = await activeDb
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const status = row?.status ?? "deleted";
  setCachedTenantStatus(tenantId, status);
  return status;
}

// Org -> tenant mappings are effectively immutable once set (a tenant is
// mapped to a Zitadel org once, at onboarding) — a short in-process TTL cache
// avoids a DB round-trip on every JWT-authenticated request in production,
// mirroring the pattern in tenant-status-cache.ts but without cross-instance
// invalidation (no admin flow ever changes zitadel_org_id, so a replica
// serving a stale entry for up to the TTL is harmless; a genuine remap can
// wait out the TTL like any other cache).
const ORG_TENANT_CACHE_TTL_MS = 5 * 60_000;
const _orgTenantCache = new Map<
  string,
  { tenantId: string | null; exp: number }
>();

function getCachedOrgTenantId(orgId: string): string | null | undefined {
  const entry = _orgTenantCache.get(orgId);
  if (!entry) return undefined;
  if (Date.now() > entry.exp) {
    _orgTenantCache.delete(orgId);
    return undefined;
  }
  return entry.tenantId;
}

function setCachedOrgTenantId(orgId: string, tenantId: string | null): void {
  _orgTenantCache.set(orgId, {
    tenantId,
    exp: Date.now() + ORG_TENANT_CACHE_TTL_MS,
  });
}

/**
 * Resolve a tenant's internal UUID from its mapped Zitadel org id. Returns
 * null if no tenant is mapped to this org — callers must fail closed, never
 * fall back to another tenant. See docs/specs/tenant-org-id-mapping.md.
 */
export async function lookupTenantIdByOrgId(
  orgId: string,
  dbHandle?: DbOrTx,
): Promise<string | null> {
  const cached = getCachedOrgTenantId(orgId);
  if (cached !== undefined) return cached;

  const activeDb = dbHandle ?? db;
  const [row] = await activeDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.zitadelOrgId, orgId))
    .limit(1);

  const tenantId = row?.id ?? null;
  setCachedOrgTenantId(orgId, tenantId);
  return tenantId;
}

// Argon2id verification is intentionally slow (~50–100 ms). Cache the result
// keyed by SHA-256(rawKey) so repeated requests with the same key only pay
// that cost once per TTL window.
const ARGON2_VERIFY_CACHE_TTL_MS = 60_000;
// Sweep expired entries when the map reaches this size to prevent unbounded
// growth under adversarial load (many unique invalid keys, each one entry).
const ARGON2_VERIFY_CACHE_MAX_ENTRIES = 10_000;
const _argon2VerifyCache = new Map<string, { valid: boolean; exp: number }>();

async function verifyArgon2(
  rawKey: string,
  storedHash: string,
): Promise<boolean> {
  const cacheKey = hashApiKey(rawKey); // SHA-256 — never the raw key
  const cached = _argon2VerifyCache.get(cacheKey);
  if (cached && Date.now() < cached.exp) return cached.valid;

  const valid = await argon2Verify(storedHash, rawKey);
  if (_argon2VerifyCache.size >= ARGON2_VERIFY_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of _argon2VerifyCache) {
      if (now >= v.exp) _argon2VerifyCache.delete(k);
    }
  }
  _argon2VerifyCache.set(cacheKey, {
    valid,
    exp: Date.now() + ARGON2_VERIFY_CACHE_TTL_MS,
  });
  return valid;
}

async function resolveApiKey(
  db: DbOrTx,
  rawKey: string,
): Promise<AuthContext | null> {
  const keyHash = hashApiKey(rawKey);

  // (#124-adjacent bug) api_keys has an RLS policy requiring app.tenant_id,
  // but we don't know the tenant until AFTER this lookup succeeds — so it
  // can't go through withTenantContext like every other tenant-scoped query.
  // resolve_api_key_by_hash (migration 0031/0047) is a narrowly-scoped
  // SECURITY DEFINER function that bypasses RLS for this one lookup-by-secret
  // and returns only id/tenant_id/scopes/key_hash_argon2, never key_hash itself.
  const result = await db.execute<{
    id: string;
    tenant_id: string;
    scopes: string[];
    key_hash_argon2: string | null;
  }>(
    sql`select id, tenant_id, scopes, key_hash_argon2 from resolve_api_key_by_hash(${keyHash}::text)`,
  );
  const row = result[0];

  if (!row) return null;

  // Argon2id verification for keys created after migration 0047. Legacy keys
  // (key_hash_argon2 IS NULL) pass on SHA-256 match alone and should be
  // rotated to gain the stronger hash. (#237)
  if (row.key_hash_argon2) {
    const valid = await verifyArgon2(rawKey, row.key_hash_argon2);
    if (!valid) return null;
  }

  // Now that the tenant is known, this write goes through the normal
  // RLS-compliant path. Best-effort: don't block the request on it.
  void withTenantContext(row.tenant_id, (tx) =>
    tx
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.id)),
  ).catch((err: unknown) => {
    logger.warn(
      { error: String(err), keyId: row.id },
      "Failed to update api_key last_used_at",
    );
  });

  return {
    userId: `apikey:${row.id}`,
    tenantId: row.tenant_id,
    roles: row.scopes,
    email: "",
    displayName: `API Key ${row.id.slice(0, 8)}`,
  };
}

// SHA-256 here is a fast lookup/cache-key hash (indexed exact-match DB lookup
// in resolve_api_key_by_hash; cache key in verifyArgon2), not the security
// verification boundary — that's argon2id (hashApiKeyArgon2/verifyArgon2,
// #237/PR #281) for keys created after migration 0047. Legacy (pre-0047) keys
// still authenticate on SHA-256 match alone until rotated — a documented,
// accepted interim state (see #291), not a missed control.
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex"); // lgtm[js/insufficient-password-hash] -- lookup/cache-key hash only, see #291
}

export function hashApiKeyArgon2(rawKey: string): Promise<string> {
  return argon2Hash(rawKey);
}
