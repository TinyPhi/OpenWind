import { createMiddleware } from "hono/factory";
import type { Context, Next, MiddlewareHandler } from "hono";
import { env } from "@platform/config";
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
import { enforceKeyPersonRateLimit } from "../../lib/rate-limit-tiers.js";

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
 * ADR-012 Phase F, spec R4 / Phase G, ADR-013 — this is also the single
 * point every real third-party route (all but attachments-upload, which is
 * presign-token-gated, not scope-gated) passes through after requireAuth +
 * requireActingPerson, making it the natural place to hook misuse triggers
 * 1 (scope-denial rate) and 2 (request volume), AND to enforce the
 * per-(key,person) rate-limit tier: the tenant tier and per-key aggregate
 * tier (both in @platform/auth's requireAuth) can't see the acting person,
 * since that identity isn't resolved until requireActingPerson runs, later
 * in the same chain.
 */
export const requireTicketScope = (verb: TicketActionVerb): MiddlewareHandler =>
  createMiddleware<Variables>(
    async (c: Context<Variables>, next: Next): Promise<Response | void> => {
      const { tenantId, roles: scopes, userId } = c.get("auth");
      if (!userId.startsWith("apikey:")) {
        return c.json({ error: "UNAUTHORIZED", message: "Invalid token" }, 401);
      }
      const { userId: actingPersonId } = c.get("actingPerson");
      const applicationActorId = applicationActorIdFromUserId(userId);

      const rateLimit = await enforceKeyPersonRateLimit(
        tenantId,
        applicationActorId,
        actingPersonId,
      );

      c.header(
        "x-ratelimit-key-person-limit",
        String(env.RATE_LIMIT_API_KEY_PERSON_PER_MIN),
      );
      c.header("x-ratelimit-key-person-remaining", String(rateLimit.remaining));
      c.header("x-ratelimit-key-person-reset", String(rateLimit.resetAt));

      if (!rateLimit.allowed) {
        return c.json(
          { error: "RATE_LIMITED", message: "Too many requests" },
          429,
        );
      }

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
