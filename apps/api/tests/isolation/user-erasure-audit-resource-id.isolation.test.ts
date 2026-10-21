/**
 * The erasure audit entry against a real database. admin_audit_log.resource_id is a uuid column
 * and a Zitadel user id is a numeric string, so writing the raw id made the insert throw inside
 * the erasure transaction and rolled the whole erasure back.
 */
import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenantContext, adminAuditLog } from "@platform/db";
import {
  auditResourceId,
  queryAuditLog,
  writeAuditEntry,
} from "@platform/audit";

const TENANT = "aaaaaaaa-7777-4000-a000-000000000001";
const OTHER_TENANT = "bbbbbbbb-7777-4000-b000-000000000002";
const ZITADEL_USER_ID = "256000000000000001";

afterAll(async () => {
  for (const t of [TENANT, OTHER_TENANT]) {
    await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, t));
  }
});

function erasureEntry(tenantId: string, resourceId: string) {
  return {
    tenantId,
    actorId: "admin-1",
    actorType: "user" as const,
    resourceType: "user",
    resourceId,
    action: "deleted" as const,
    metadata: { userId: ZITADEL_USER_ID },
  };
}

describe("erasure audit entry for a numeric Zitadel user id", () => {
  it("is rejected by the uuid column when the raw id is written (the old behaviour)", async () => {
    await expect(
      withTenantContext(TENANT, (tx) =>
        writeAuditEntry(tx, erasureEntry(TENANT, ZITADEL_USER_ID)),
      ),
    ).rejects.toThrow();
  });

  it("is written with the mapped uuid, found by it, and keeps the real id in metadata", async () => {
    await withTenantContext(TENANT, (tx) =>
      writeAuditEntry(
        tx,
        erasureEntry(TENANT, auditResourceId(ZITADEL_USER_ID)),
      ),
    );
    const { entries } = await withTenantContext(TENANT, (tx) =>
      queryAuditLog(tx, {
        tenantId: TENANT,
        resourceId: auditResourceId(ZITADEL_USER_ID),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.metadata).toEqual({ userId: ZITADEL_USER_ID });
  });

  it("does not show another tenant's entry for the same user id", async () => {
    await withTenantContext(OTHER_TENANT, (tx) =>
      writeAuditEntry(
        tx,
        erasureEntry(OTHER_TENANT, auditResourceId(ZITADEL_USER_ID)),
      ),
    );
    const { entries } = await withTenantContext(TENANT, (tx) =>
      queryAuditLog(tx, {
        tenantId: TENANT,
        resourceId: auditResourceId(ZITADEL_USER_ID),
      }),
    );
    expect(entries.every((e) => e.tenantId === TENANT)).toBe(true);
    expect(entries).toHaveLength(1);
  });
});
