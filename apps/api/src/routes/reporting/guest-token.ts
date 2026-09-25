import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { writeAuditEntry } from "@platform/audit";
import { env } from "@platform/config";
import { withTenantContext } from "@platform/db";
import { logger } from "@platform/logger";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import {
  mintDashboardPass,
  SupersetUnavailableError,
  type RlsRule,
} from "./superset-client.js";

const QuerySchema = z.object({
  dashboard: z.enum(["tenant", "user"]),
});

// tenantId is a platform-generated UUID. userId is NOT a UUID — Zitadel issues
// a numeric subject (e.g. 386221876596178947) and an API-key principal is
// `apikey:<uuid>`, which is why the rest of the codebase types it as
// z.string().min(1). Validating both as UUIDs would make the per-user dashboard
// fail 100% of the time.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An allowlist, not a denylist. These ids are interpolated into a raw SQL
// fragment that Superset ANDs into every query on the dashboard — a row filter
// has no parameterised form — so the defence is permitting only characters that
// cannot terminate or escape the string literal. Note `-` and `:` are permitted
// deliberately: `apikey:<uuid>` needs both, and neither can break out of a
// quoted literal.
const PRINCIPAL_ID_RE = /^[A-Za-z0-9_.:@-]{1,255}$/;

/**
 * How each dataset on the per-user dashboard is narrowed to the viewer.
 *
 * Every dataset the dashboard reads must appear here. Superset scopes a row
 * filter to one dataset, and a dataset with no rule attached comes back
 * *unfiltered* rather than empty — so an omission fails open: the whole
 * tenant's tickets under a personal label.
 *
 * The clause differs per dataset because the question does. The detail table
 * shows anything the viewer is involved in; the two counters exist to separate
 * that into what they raised and what landed on them, which is only possible
 * because each gets its own dataset and therefore its own filter. The three
 * read the same rows, so raised + assigned overlap wherever someone raised a
 * ticket that came back to them — they are two measures, not two halves.
 */
const PER_USER_DATASET_FILTERS: Record<string, (userId: string) => string> = {
  entity_instances: (id) => `(assigned_to = '${id}' OR created_by = '${id}')`,
  ticket_list: (id) => `(assigned_to = '${id}' OR created_by = '${id}')`,
  my_tickets_created: (id) => `created_by = '${id}'`,
  my_tickets_assigned: (id) => `assigned_to = '${id}'`,
};

const DASHBOARD_SLUGS: Record<"tenant" | "user", string> = {
  tenant: env.SUPERSET_DASHBOARD_TENANT_SLUG,
  user: env.SUPERSET_DASHBOARD_USER_SLUG,
};

/**
 * Build the row filters Superset ANDs into every query the dashboard runs.
 *
 * These are the second isolation layer, not the only one. The first is the
 * database: the reporting role no longer bypasses row-level security, and the
 * tenant is stamped onto the connection from the guest token's username, so a
 * missing or wrong filter here yields no rows rather than another tenant's.
 * See docker/superset/superset_config.py and migration 0112.
 */
function buildRlsRules(
  dashboard: "tenant" | "user",
  tenantId: string,
  userId: string,
): RlsRule[] {
  if (!UUID_RE.test(tenantId)) {
    throw new SupersetUnavailableError(
      "auth context carried a malformed tenant id",
    );
  }
  if (dashboard === "user" && !PRINCIPAL_ID_RE.test(userId)) {
    throw new SupersetUnavailableError(
      "auth context carried a malformed principal id",
    );
  }

  // Deliberately unscoped: every reporting table carries `tenant_id`, and a
  // tenant clause that missed a dataset would be exactly the hole this filter
  // exists to close.
  const rules: RlsRule[] = [{ clause: `tenant_id = '${tenantId}'` }];

  if (dashboard === "user") {
    // Assigned-or-created only. Deliberately narrower than the platform's full
    // "my work" predicate: the third leg (the __accessUsers grant list) lives
    // in the fields JSONB column, which no tile may read, so it is not
    // reachable from here. Do not "fix" this by opening up that column.
    //
    // One rule per dataset, and that scoping is load-bearing in both
    // directions. Superset applies an unscoped rule to *every* dataset on the
    // dashboard as raw SQL with no column checking, so naming no dataset
    // breaks every event-backed tile with an unknown-column error. But naming
    // too few is the dangerous direction: a dataset with no rule attached is
    // returned unfiltered, so a per-user tile built on it would show the whole
    // tenant under a personal label. Adding a dataset to the dashboard means
    // adding it to PER_USER_DATASET_FILTERS in the same change, not after.
    for (const [datasetTable, toClause] of Object.entries(
      PER_USER_DATASET_FILTERS,
    )) {
      rules.push({ clause: toClause(userId), datasetTable });
    }
  }
  return rules;
}

/**
 * Durable record of a dashboard access decision, in the platform audit store.
 *
 * The application log is not enough on its own: it rotates and is not
 * queryable, so it cannot answer "who viewed which reporting dashboards, and
 * when" for a data-subject request or an incident window.
 *
 * Best-effort: a failed audit write is logged loudly and does not fail the
 * request. The pass is minted every ~55s per open dashboard, so turning an
 * audit-store hiccup into a broken dashboard would be worse for the user than
 * one missing row, and the database is also what serves the dashboard.
 */
async function recordGuestTokenAudit(
  tenantId: string,
  userId: string,
  action: "reporting.guest_token_issued" | "reporting.guest_token_denied",
  dashboard: "tenant" | "user",
  embeddedId?: string,
): Promise<void> {
  try {
    await withTenantContext(tenantId, (tx) =>
      writeAuditEntry(tx, {
        tenantId,
        actorId: userId,
        actorType: "user",
        resourceType: "reporting_dashboard",
        // The embedded dashboard's id when there is one; a refused request has
        // no resource, and the column is a required UUID.
        resourceId:
          embeddedId && UUID_RE.test(embeddedId) ? embeddedId : randomUUID(),
        action,
        metadata: { dashboard, dashboardSlug: DASHBOARD_SLUGS[dashboard] },
      }),
    );
  } catch (auditErr) {
    logger.error(
      { tenantId, userId, action, dashboard, auditErr },
      "reporting: failed to write guest token audit entry",
    );
  }
}

export const guestTokenHandler = factory.createHandlers(
  requireAuth(),
  // "user" added so end customers can reach their own "My Tickets" dashboard.
  // The tenant-wide dashboard stays admin/agent-only — enforced below, inside
  // the handler, since it depends on which dashboard was requested.
  requireRole("agent", "admin", "user"),
  // requireIntrospection() was tried here and reverted. Its own doc comment
  // reserves it for rare, sensitive operations (tenant deletion, permission
  // changes) — this endpoint is the opposite of that: the SDK re-mints a pass
  // roughly every 55s per open dashboard, so introspection turned a routine,
  // frequent call into a hot dependency on a live Zitadel round-trip. Verified
  // live: with Zitadel marked unhealthy, every mint failed and surfaced to the
  // user as "session expired" on a page that had nothing wrong with its
  // session. JWT verification via requireAuth() is the same protection every
  // other route in this codebase relies on; this endpoint is not special
  // enough to justify a different, more fragile one.
  //
  // Known residual gap, stated rather than papered over: a *role downgrade*
  // inside a still-valid token is not caught by anything on this path. Roles
  // reach us only as JWT claims — tenant_users carries no role column — so
  // there is nothing live and cheap to re-check. The 60s pass lifetime (R9)
  // bounds this the same way it bounds every other revocation case here;
  // closing it further means either shorter token lifetimes platform-wide or
  // a purpose-built, cached role lookup — both bigger than this endpoint.
  zValidator("query", QuerySchema),
  async (c) => {
    const { tenantId, userId, roles } = c.get("auth");
    const { dashboard } = c.req.valid("query");
    const startedAt = Date.now();

    const isStaff = roles.includes("admin") || roles.includes("agent");
    if (dashboard === "tenant" && !isStaff) {
      // Belt-and-braces: the UI never offers this tab to a customer, but the
      // query param is typed and guessable, and the tenant dashboard shows
      // every ticket in the tenant, not just the caller's own.
      await recordGuestTokenAudit(
        tenantId,
        userId,
        "reporting.guest_token_denied",
        dashboard,
      );
      return c.json(
        { error: "FORBIDDEN", message: "Insufficient permissions" },
        403,
      );
    }

    try {
      const rls = buildRlsRules(dashboard, tenantId, userId);
      const { token, embeddedId } = await mintDashboardPass(
        DASHBOARD_SLUGS[dashboard],
        tenantId,
        rls,
        // The per-viewer dashboard must have every dataset filtered.
        // Refusing to mint is the correct outcome if one is not: the
        // alternative is a personal tile quietly showing the whole tenant.
        dashboard === "user",
      );

      logger.info(
        { tenantId, userId, dashboard, embeddedId },
        "reporting: guest token minted",
      );
      await recordGuestTokenAudit(
        tenantId,
        userId,
        "reporting.guest_token_issued",
        dashboard,
        embeddedId,
      );

      return c.json({
        data: {
          token,
          dashboardId: embeddedId,
          supersetDomain: env.SUPERSET_SITE_URL,
        },
      });
    } catch (err) {
      logger.warn(
        { err, tenantId, dashboard, durationMs: Date.now() - startedAt },
        "reporting: Superset call failed",
      );
      // Flat, identical message on every failure path. No host, status code or
      // service-account identity reaches the browser — a detailed error here
      // would describe the internal topology to an unauthenticated-ish surface.
      return c.json(
        {
          error: "REPORTING_UNAVAILABLE",
          message: "Reporting dashboard is not available right now",
        },
        502,
      );
    }
  },
);
