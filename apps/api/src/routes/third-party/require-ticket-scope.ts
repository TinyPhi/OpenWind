import { createMiddleware } from "hono/factory";
import type { Context, Next, MiddlewareHandler } from "hono";
import type {
  AuthContext,
  ActingPersonContext,
  TicketActionVerb,
} from "@platform/auth";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";
import {
  recordScopeDenialAndMaybeAlert,
  recordRequestVolumeAndMaybeAlert,
} from "../../lib/misuse-alerts.js";

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
 *
 * ADR-012 Phase F, spec R4 — this is also the single point every real
 * third-party route (all but attachments-upload, which is presign-token-
 * gated, not scope-gated) passes through after requireAuth, making it the
 * natural place to hook misuse triggers 1 (scope-denial rate) and 2
 * (request volume) without touching every route handler individually.
 */
export const requireTicketScope = (verb: TicketActionVerb): MiddlewareHandler =>
  createMiddleware<Variables>(
    async (c: Context<Variables>, next: Next): Promise<Response | void> => {
      const { tenantId, roles: scopes, userId } = c.get("auth");
      if (!userId.startsWith("apikey:")) {
        return c.json({ error: "UNAUTHORIZED", message: "Invalid token" }, 401);
      }
      const applicationActorId = applicationActorIdFromUserId(userId);
      if (!scopes.includes(`entity:ticket:${verb}`)) {
        await recordScopeDenialAndMaybeAlert(tenantId, applicationActorId);
        return c.json(
          { error: "FORBIDDEN", message: "Insufficient permissions" },
          403,
        );
      }
      await recordRequestVolumeAndMaybeAlert(tenantId, applicationActorId);
      await next();
      return;
    },
  );
