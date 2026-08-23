import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db } from "@platform/db";
import { getEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

function isEntityNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "EntityError" &&
    (err as Error & { code?: string }).code === "ENTITY_NOT_FOUND"
  );
}

// Deliberately the exact same body as the access-denied branch below — this
// is the specific ticket-existence-oracle the design doc's Round 2 CRITICAL
// finding requires closed: a genuinely nonexistent ticket and an
// inaccessible one must be indistinguishable to the caller, not just share
// a 404 status with different error codes/messages (the human-UI route,
// entities/get.ts, doesn't hold to this bar via handleEntityError's generic
// ENTITY_NOT_FOUND mapping — that's fine for a session that already knows
// which IDs plausibly exist, but not for this API).
function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

/**
 * GET /api/v1/tickets/:id — ADR-012 Phase B, spec R7.
 *
 * Access-list gated via the same shared hasEntityAccess helper the UI's own
 * entity-detail route (entities/get.ts) uses — not a re-implemented inline
 * check. Always 404 on denial, INCLUDING a cross-tenant ticket ID: getEntity
 * already applies an explicit `tenant_id = ?` filter (defense-in-depth
 * alongside entity_instances' own RLS), so a cross-tenant row throws the
 * exact same ENTITY_NOT_FOUND a genuinely nonexistent ID would — no separate
 * cross-tenant branch exists to add here, matching the platform's standard
 * 404-not-403 convention (security.md).
 *
 * The acting person has no internal RBAC role in this system (they never log
 * into OpenWind — that's the whole point of the third-party API) — passing
 * an empty roles array means hasEntityAccess's admin/agent bypass never
 * fires, and access reduces purely to the ACL fields (creator/assignee/
 * __accessUsers) or workflow-admin status, exactly the access-list model
 * the design doc's interview section specifies for this identity.
 */
export const getThirdPartyTicketHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("read"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    const { userId } = c.get("actingPerson");

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, id),
      );

      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityAccess(tx, tenantId, instance, userId, []),
      );
      if (!allowed) {
        return notFound(c);
      }

      return c.json({ data: instance });
    } catch (err) {
      if (isEntityNotFound(err)) {
        return notFound(c);
      }
      throw err;
    }
  },
);
