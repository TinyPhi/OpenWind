import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Context, Next, MiddlewareHandler } from "hono";
import type { DbOrTx } from "@platform/db";
import { apiKeys } from "@platform/db";
import { logger } from "@platform/logger";
import { verifyJwt, extractAuthContext } from "./jwks.js";
import { introspectToken } from "./introspection.js";
import type { AuthContext } from "./types.js";

type AuthVariables = { Variables: { auth: AuthContext } };

/**
 * requireAuth — validates Bearer JWT (Zitadel JWKS) or API key (sk_... prefix).
 *
 * JWT path: verifies signature, extracts tenantId from org claim, roles from project claims.
 * API key path: hashes the raw key, looks up in api_keys table, loads tenant from key row.
 *
 * The `db` parameter is only needed for API key validation; JWT-only routes can omit it
 * by passing undefined.  If an API key arrives and db is undefined the request is rejected.
 */
export const requireAuth = (db?: DbOrTx): MiddlewareHandler =>
  createMiddleware<AuthVariables>(
    async (c: Context<AuthVariables>, next: Next): Promise<Response | void> => {
      // Short-circuit when auth has been pre-populated (e.g. by test fixtures
      // or an upstream gateway that already verified the token).
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
        c.set("auth", auth);
        await next();
        return;
      }

      // JWT path
      const claims = await verifyJwt(token);
      if (!claims) {
        return c.json({ error: "UNAUTHORIZED", message: "Invalid token" }, 401);
      }

      const auth = extractAuthContext(claims);
      if (!auth) {
        return c.json(
          { error: "UNAUTHORIZED", message: "Missing required claims" },
          401,
        );
      }

      c.set("auth", auth);
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

async function resolveApiKey(
  db: DbOrTx,
  rawKey: string,
): Promise<AuthContext | null> {
  const keyHash = hashApiKey(rawKey);

  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  if (!row) return null;

  // Best-effort: update last_used_at without blocking the request
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch((err: unknown) => {
      logger.warn(
        { error: String(err), keyId: row.id },
        "Failed to update api_key last_used_at",
      );
    });

  return {
    userId: `apikey:${row.id}`,
    tenantId: row.tenantId,
    roles: row.scopes,
    email: "",
  };
}

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
