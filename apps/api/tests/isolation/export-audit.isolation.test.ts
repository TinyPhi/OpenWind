/**
 * #638 / docs/specs/export-audit-trail.md R1, R5: a real sync export through
 * the real route writes export.requested + export.completed rows into
 * admin_audit_log for the exporting tenant only, and migration 0127's CHECK
 * constraint accepts the export.* actions while still rejecting unknown ones.
 *
 * Real Postgres; only auth (and the queue module, unused on the sync path) are
 * mocked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  withTenantContext,
  adminAuditLog,
  entityInstances,
  entityTypes,
  entityFields,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";

const TENANT = "aaaaaaaa-0638-4000-a000-000000000001";
const OTHER = "bbbbbbbb-0638-4000-b000-000000000002";

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("../../src/lib/export-queue.js", () => ({
  exportQueue: { add: vi.fn() },
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

const { exportEntitiesHandler } =
  await import("../../src/routes/entity-types/export.js");

let entityTypeId: string;

function app(): Hono<{ Variables: { auth: AuthContext } }> {
  const a = new Hono<{ Variables: { auth: AuthContext } }>();
  a.use("*", async (c, next) => {
    c.set("auth", {
      tenantId: TENANT,
      userId: "u-exporter",
      roles: ["agent"],
      email: "exporter@example.com",
    });
    await next();
  });
  a.get("/:id/export", ...exportEntitiesHandler);
  return a;
}

async function exportRows(
  tenantId: string,
): Promise<Array<{ action: string; metadata: unknown }>> {
  return db
    .select({ action: adminAuditLog.action, metadata: adminAuditLog.metadata })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        like(adminAuditLog.action, "export.%"),
      ),
    )
    .orderBy(adminAuditLog.createdAt);
}

beforeAll(async () => {
  for (const id of [TENANT, OTHER]) {
    await db
      .insert(tenants)
      .values({ id, name: `#638 ${id}`, slug: `export-audit-${id}` })
      .onConflictDoNothing();
  }
  const et = await createEntityType(db, TENANT, {
    name: `export_audit_${Date.now()}`,
    plural: "export_audits",
    allowCustomFields: true,
  });
  entityTypeId = et.id;
  for (const title of ["one", "two"]) {
    await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, { entityTypeId, fields: { title } }),
    );
  }
});

afterAll(async () => {
  for (const id of [TENANT, OTHER]) {
    await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, id));
    await db.delete(entityInstances).where(eq(entityInstances.tenantId, id));
    await db.delete(entityFields).where(eq(entityFields.tenantId, id));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("export audit trail (#638)", () => {
  it("a sync export writes requested and completed rows for the exporting tenant only", async () => {
    const res = await app().request(`/${entityTypeId}/export?format=csv`);
    expect(res.status).toBe(200);

    const rows = await exportRows(TENANT);
    expect(rows.map((r) => r.action)).toEqual([
      "export.requested",
      "export.completed",
    ]);
    expect(rows[0]?.metadata).toMatchObject({
      format: "csv",
      includePii: false,
      rowCount: 2,
      mode: "sync",
    });
    // Read as the other tenant under RLS (app_user), not through an explicit
    // filter — the exporting tenant's rows must be invisible.
    const seenByOther = await withTenantContext(OTHER, (tx) =>
      tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(like(adminAuditLog.action, "export.%")),
    );
    expect(seenByOther).toEqual([]);
  });

  it("the audit constraint still rejects an unknown action", async () => {
    const err: unknown = await db
      .insert(adminAuditLog)
      .values({
        tenantId: TENANT,
        actorId: "u-exporter",
        actorType: "user",
        resourceType: "entity_type",
        resourceId: entityTypeId,
        // deliberately outside the AuditAction vocabulary
        action: "export.leaked" as never,
      })
      .catch((e: unknown) => e);
    expect(String((err as { cause?: unknown })?.cause ?? err)).toContain(
      "audit_log_action_check",
    );
  });
});
