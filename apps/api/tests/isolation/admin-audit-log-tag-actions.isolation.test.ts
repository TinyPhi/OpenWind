/**
 * Regression test for a real CHECK-constraint bug found via OWTester
 * functional testing (ADR-012 Phase C): admin_audit_log.action has a
 * Postgres CHECK constraint allowlist (0011_admin_audit_log.sql) that
 * mention-resolution-worker.ts's 6 tag.* actions were never added to
 * (0076_admin_audit_log_tag_actions.sql fixes it). Every unit test around
 * that worker mocks @platform/db, so nothing exercised the real constraint
 * before this — this test inserts against a live Postgres instance
 * specifically so a future action string can't reintroduce the same gap
 * (same bug class as 0038_audit_log_purge_actions.sql).
 *
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenantContext } from "@platform/db";
import { adminAuditLog } from "@platform/db";
import { writeAuditEntry, type AuditAction } from "@platform/audit";

const TENANT_ID = "cccccccc-2222-4000-c000-000000000001";
const RESOURCE_ID = "cccccccc-2222-4000-c000-000000000100";

const TAG_ACTIONS: AuditAction[] = [
  "tag.resolved_existing_access",
  "tag.auto_granted",
  "tag.access_request_created",
  "tag.fallback",
  "tag.resolution_failed",
  "tag.misuse_rate_capped",
];

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_ID));
});

describe("admin_audit_log — tag.* action CHECK constraint", () => {
  for (const action of TAG_ACTIONS) {
    it(`accepts a real insert of action "${action}"`, async () => {
      await withTenantContext(TENANT_ID, (tx) =>
        writeAuditEntry(tx, {
          tenantId: TENANT_ID,
          actorId: "api-key-under-test",
          actorType: "api_key",
          actingPersonId: "person-under-test",
          resourceType: "ticket",
          resourceId: RESOURCE_ID,
          action,
          metadata: { commentId: "comment-under-test" },
        }),
      );

      const rows = await withTenantContext(TENANT_ID, (tx) =>
        tx
          .select({ action: adminAuditLog.action })
          .from(adminAuditLog)
          .where(eq(adminAuditLog.resourceId, RESOURCE_ID)),
      );
      expect(rows.some((r) => r.action === action)).toBe(true);
    });
  }
});
