/**
 * GET /admin/third-party-access-logs — ADR-012 Phase F.
 *
 * Admin-only, tenant-scoped read over the existing admin_audit_log rows
 * written by every third-party route (Phases B-E). Adds application-name
 * resolution and outcome classification on top of the existing
 * `queryAuditLog` — no new query engine, no new write path.
 */
import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext, apiKeys } from "@platform/db";
import { queryAuditLog, classifyOutcome } from "@platform/audit";
import { and, eq, inArray } from "drizzle-orm";
import { factory } from "./factory.js";

const AccessLogsQuerySchema = z.object({
  // Admin-UI API Keys card view — an "application" can span multiple key
  // rows (rotations), so its access-log filter needs to match any one of
  // several application (api key) ids, not just a single exact one. Accepts
  // either a single uuid (unchanged from before) or a comma-separated list.
  application: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().uuid()).min(1))
    .optional(),
  // PR #489 review, F-02 -- a cleared form field submits "" not undefined;
  // .min(1) rejects it at the boundary instead of silently generating
  // WHERE acting_person_id = '' (zero rows, no explanation to the admin).
  personId: z.string().min(1).optional(),
  ticketId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  outcome: z.enum(["allowed", "denied"]).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const getThirdPartyAccessLogsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("query", AccessLogsQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const q = c.req.valid("query");

    const result = await withTenantContext(tenantId, async (tx) => {
      const logResult = await queryAuditLog(tx, {
        tenantId,
        actorType: "api_key",
        actorId: q.application,
        actingPersonId: q.personId,
        resourceType: "ticket",
        resourceId: q.ticketId,
        outcome: q.outcome,
        from: q.from !== undefined ? new Date(q.from) : undefined,
        to: q.to !== undefined ? new Date(q.to) : undefined,
        cursor: q.cursor,
        limit: q.limit,
      });

      const keyIds = [...new Set(logResult.entries.map((e) => e.actorId))];
      const applicationNames = new Map<string, string | null>();
      if (keyIds.length > 0) {
        // Explicit tenant filter (security.md rule 1) -- RLS already scopes
        // this via withTenantContext, but the explicit WHERE is the primary
        // guard and must not be dropped on the assumption RLS alone covers
        // it (keyIds is derived from already-tenant-scoped audit rows today,
        // but that's incidental to this query, not enforced by it).
        const keys = await tx
          .select({ id: apiKeys.id, applicationName: apiKeys.applicationName })
          .from(apiKeys)
          .where(
            and(inArray(apiKeys.id, keyIds), eq(apiKeys.tenantId, tenantId)),
          );
        for (const key of keys) {
          applicationNames.set(key.id, key.applicationName);
        }
      }

      return { logResult, applicationNames };
    });

    const data = result.logResult.entries.map((entry) => ({
      id: entry.id,
      timestamp: entry.createdAt.toISOString(),
      applicationName: result.applicationNames.get(entry.actorId) ?? null,
      applicationKeyId: entry.actorId,
      actingPersonId: entry.actingPersonId ?? null,
      ticketId: entry.resourceId,
      action: entry.action,
      outcome: classifyOutcome(entry.action),
    }));

    return c.json({ data, nextCursor: result.logResult.nextCursor });
  },
);
