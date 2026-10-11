/**
 * #640 — admin_audit_log.action CHECK constraint drift guard.
 *
 * Migration 0140 re-creates audit_log_action_check with the five role/permission-change
 * actions. Every AuditAction in the TS union must be accepted by the real constraint
 * (same bug class as 0038 / 0076), and a tenant must not see another tenant's rows.
 *
 * Requires a live Postgres instance with migrations applied (docker compose up -d).
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { db, withTenantContext, adminAuditLog } from "@platform/db";
import { actionsForOutcome, type AuditAction } from "@platform/audit";

const TENANT_A = "dddddddd-2222-4000-d000-000000000001";
const TENANT_B = "eeeeeeee-2222-4000-e000-000000000002";
const RESOURCE_ID = "dddddddd-2222-4000-d000-000000000100";

// ALL_AUDIT_ACTIONS is not re-exported from the package root; allowed + denied
// partitions the union exhaustively (classifyOutcome is total over AuditAction).
const ALL_ACTIONS: readonly AuditAction[] = [
  ...actionsForOutcome("allowed"),
  ...actionsForOutcome("denied"),
];

const NEW_ACTIONS: readonly AuditAction[] = [
  "access.granted",
  "access.updated",
  "access.revoked",
  "workflow.admins_updated",
  "workflow.transition_roles_updated",
];

// Admitted by 0140 for the open sandbox-delete PR stack; not (yet) in the TS union.
const SANDBOX_DELETE_ACTIONS: readonly string[] = [
  "sandbox.delete_completed",
  "sandbox.delete_failed",
];

function insertEntry(tenantId: string, action: string): Promise<void> {
  return withTenantContext(tenantId, async (tx) => {
    await tx.insert(adminAuditLog).values({
      tenantId,
      actorId: "user-under-test",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action,
      beforeSnapshot: null,
      afterSnapshot: null,
      metadata: null,
    });
  });
}

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_A));
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_B));
});

describe("admin_audit_log — action CHECK vs AuditAction union (0140)", () => {
  it("covers the five new actions in the union", () => {
    for (const action of NEW_ACTIONS) {
      expect(ALL_ACTIONS).toContain(action);
    }
  });

  for (const action of ALL_ACTIONS) {
    it(`accepts an app_user insert of "${action}"`, async () => {
      await expect(insertEntry(TENANT_A, action)).resolves.toBeUndefined();
    });
  }

  for (const action of SANDBOX_DELETE_ACTIONS) {
    it(`accepts an app_user insert of "${action}" (admitted by 0140, not in the union)`, async () => {
      await expect(insertEntry(TENANT_A, action)).resolves.toBeUndefined();
    });
  }

  it("rejects an action string outside the allowlist", async () => {
    await expect(
      insertEntry(TENANT_A, "access.bogus_action"),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

describe("admin_audit_log — new actions are tenant-isolated (RLS)", () => {
  it("tenant B cannot read tenant A's new-action rows", async () => {
    for (const action of NEW_ACTIONS) {
      await insertEntry(TENANT_A, action);
    }

    const asA = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ action: adminAuditLog.action })
        .from(adminAuditLog)
        .where(inArray(adminAuditLog.action, [...NEW_ACTIONS])),
    );
    expect(new Set(asA.map((r) => r.action))).toEqual(new Set(NEW_ACTIONS));

    // No tenant_id predicate on purpose: only RLS can hide the rows here.
    const asB = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(inArray(adminAuditLog.action, [...NEW_ACTIONS])),
    );
    expect(asB).toHaveLength(0);

    const asBByResource = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.resourceId, RESOURCE_ID),
            eq(adminAuditLog.tenantId, TENANT_A),
          ),
        ),
    );
    expect(asBByResource).toHaveLength(0);
  });

  it("tenant B cannot insert a row attributed to tenant A", async () => {
    await expect(
      withTenantContext(TENANT_B, async (tx) => {
        await tx.insert(adminAuditLog).values({
          tenantId: TENANT_A,
          actorId: "user-b",
          actorType: "user",
          resourceType: "ticket",
          resourceId: RESOURCE_ID,
          action: "access.granted",
          beforeSnapshot: null,
          afterSnapshot: null,
          metadata: null,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});
