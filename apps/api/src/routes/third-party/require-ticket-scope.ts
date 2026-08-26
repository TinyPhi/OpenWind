import { createMiddleware } from "hono/factory";
import type { Context, Next, MiddlewareHandler } from "hono";
import type {
  AuthContext,
  ActingPersonContext,
  TicketActionVerb,
} from "@platform/auth";
import { enforceKeyPersonRateLimit } from "../../lib/rate-limit-tiers.js";

type Variables = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

// requireAuth (@platform/auth) sets auth.userId to "apikey:<id>" on the
// API-key path -- every third-party route is reachable only via that path
// (requireActingPerson, which runs before this middleware in every route's
// chain, already 401s on any userId that doesn't match this shape), so
// parsing it here needs no fallback branch.
function apiKeyIdFromUserId(userId: string): string {
  return userId.slice("apikey:".length);
}

/**
 * ADR-012 Phase B, spec R8 — no `requireScope()` helper exists yet in
 * @platform/auth (ADR-008 Decision #6's Stage 3 reopen is still pending), so
 * each third-party ticket-lifecycle route enforces its own required
 * `entity:ticket:<verb>` scope inline, the same way existing routes check
 * `auth.roles.includes("admin"|"agent")` for role-format keys. This is only
 * the key-scopes half of R8's 3-way intersection (key scopes ∩ person RBAC ∩
 * tenant RLS) — the other two are enforced downstream by the access-list
 * check (hasEntityAccess) and withTenantContext respectively.
 *
 * ADR-012 Phase G, ADR-013 — also the single point every real third-party
 * route passes through after requireAuth + requireActingPerson, making it
 * the natural place to enforce the per-(key,person) rate-limit tier: the
 * tenant tier and per-key aggregate tier (both in @platform/auth's
 * requireAuth) can't see the acting person, since that identity isn't
 * resolved until requireActingPerson runs, later in the same chain.
 */
export const requireTicketScope = (verb: TicketActionVerb): MiddlewareHandler =>
  createMiddleware<Variables>(
    async (c: Context<Variables>, next: Next): Promise<Response | void> => {
      const { tenantId, roles: scopes, userId } = c.get("auth");
      const { userId: actingPersonId } = c.get("actingPerson");
      const apiKeyId = apiKeyIdFromUserId(userId);

      const rateLimit = await enforceKeyPersonRateLimit(
        tenantId,
        apiKeyId,
        actingPersonId,
      );
      if (!rateLimit.allowed) {
        return c.json(
          { error: "RATE_LIMITED", message: "Too many requests" },
          429,
        );
      }

      if (!scopes.includes(`entity:ticket:${verb}`)) {
        return c.json(
          { error: "FORBIDDEN", message: "Insufficient permissions" },
          403,
        );
      }
      await next();
      return;
    },
  );
