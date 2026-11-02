/**
 * GET /public/org-branding/:key -- the login page's brand lookup (R13,
 * docs/specs/multi-org-sandbox.md). UNAUTHENTICATED: the visitor has not signed in, so there is
 * no tenant context and nothing to key a limit on but the client address.
 *
 * `key` is the sandbox's random login key (tenants.login_key), not its slug: nothing about a
 * company's name leads to it.
 *
 * What it must never do (§V): tell an unknown key from a real tenant, a non-active sandbox or a
 * malformed key (one 404, one body, none cached); return more than `name` and `logo`; read the
 * database before the key has passed validation; or go without a limit of its own.
 */
import { z } from "zod";
import { db, tenants } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { rateLimitKey } from "../../middleware/rate-limit.js";
import { enforcePublicBrandingRateLimit } from "../../lib/rate-limit-tiers.js";
import { factory } from "./factory.js";

// 16 lowercase hex characters, exactly what tenants_login_key_check allows.
const LoginKeySchema = z.string().regex(/^[0-9a-f]{16}$/);

const NOT_FOUND = { error: "NOT_FOUND", message: "Not found" } as const;

export const getOrgBrandingByKeyHandler = factory.createHandlers(async (c) => {
  const limit = await enforcePublicBrandingRateLimit(rateLimitKey(c));
  if (!limit.allowed) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "RATE_LIMITED", message: "Too many requests" }, 429);
  }

  // A malformed key is the same 404 as an unknown one, and is refused before any query.
  const key = LoginKeySchema.safeParse(c.req.param("key"));
  if (!key.success) {
    c.header("Cache-Control", "no-store");
    return c.json(NOT_FOUND, 404);
  }

  // `tenants` has no RLS policy in any migration, so these explicit filters are the only guard:
  // only an active sandbox is ever answered, never a real customer's tenant (which also holds no
  // key, by CHECK).
  const [row] = await db
    .select({ name: tenants.name, logo: tenants.logo })
    .from(tenants)
    .where(
      and(
        eq(tenants.loginKey, key.data),
        eq(tenants.isSandbox, true),
        eq(tenants.status, "active"),
      ),
    )
    .limit(1);
  if (!row) {
    c.header("Cache-Control", "no-store");
    return c.json(NOT_FOUND, 404);
  }

  // A hit may be cached briefly, so a name or logo edit shows within a minute; a miss never is,
  // so a sandbox created a moment ago works at once.
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ data: { name: row.name, logo: row.logo } });
});
