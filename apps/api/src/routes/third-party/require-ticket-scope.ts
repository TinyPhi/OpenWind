import { createMiddleware } from "hono/factory";
import type { Context, Next, MiddlewareHandler } from "hono";
import type {
  AuthContext,
  ActingPersonContext,
  TicketActionVerb,
} from "@platform/auth";

type Variables = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

/**
 * ADR-012 Phase B, spec R8 — no `requireScope()` helper exists yet in
 * @platform/auth (ADR-008 Decision #6's Stage 3 reopen is still pending), so
 * each third-party ticket-lifecycle route enforces its own required
 * `entity:ticket:<verb>` scope inline, the same way existing routes check
 * `auth.roles.includes("admin"|"agent")` for role-format keys. This is only
 * the key-scopes half of R8's 3-way intersection (key scopes ∩ person RBAC ∩
 * tenant RLS) — the other two are enforced downstream by the access-list
 * check (hasEntityAccess) and withTenantContext respectively.
 */
export const requireTicketScope = (verb: TicketActionVerb): MiddlewareHandler =>
  createMiddleware<Variables>(
    async (c: Context<Variables>, next: Next): Promise<Response | void> => {
      const { roles: scopes } = c.get("auth");
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
