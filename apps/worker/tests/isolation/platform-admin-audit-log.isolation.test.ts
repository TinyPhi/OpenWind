/**
 * T16 (docs/specs/multi-org-sandbox.md), ADR-022 Decision 7. Real Postgres -- confirms
 * recordPlatformAdminAction/listPlatformAdminAuditLog's actual query behavior, since the API
 * route's own test (apps/api/src/routes/platform-admin/audit-log.test.ts) mocks
 * listPlatformAdminAuditLog entirely and never exercises the real keyset-pagination cursor
 * logic (security review finding, PR #T16): in particular, that a non-existent `before` id
 * resolves to an empty array rather than a thrown error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  platformAdminAuditLog,
  recordPlatformAdminAction,
  listPlatformAdminAuditLog,
} from "@platform/db";

const TENANT_ID = "eeeeeeee-0180-4000-e000-000000000180";
const OTHER_TENANT_ID = "eeeeeeee-0180-4000-e000-000000000181";
const MISSING_ENTRY_ID = "99999999-9999-4999-8999-999999999999";

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: TENANT_ID,
        name: "T16 audit-log regression tenant",
        slug: `t16-audit-log-${Date.now()}`,
        isSandbox: true,
        status: "active",
      },
      {
        id: OTHER_TENANT_ID,
        name: "T16 audit-log regression tenant (other)",
        slug: `t16-audit-log-other-${Date.now()}`,
        isSandbox: true,
        status: "active",
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await db
    .delete(platformAdminAuditLog)
    .where(eq(platformAdminAuditLog.targetTenantId, TENANT_ID));
  await db
    .delete(platformAdminAuditLog)
    .where(eq(platformAdminAuditLog.targetTenantId, OTHER_TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT_ID));
});

describe("platform-admin-audit-log (T16)", () => {
  it("records an action and lists it back newest-first", async () => {
    await recordPlatformAdminAction({
      actorSub: "pa-1",
      action: "sandbox.created",
      targetTenantId: TENANT_ID,
    });
    await recordPlatformAdminAction({
      actorSub: "pa-1",
      action: "sandbox.reset",
      targetTenantId: TENANT_ID,
    });

    const entries = await listPlatformAdminAuditLog({ limit: 50 });
    const own = entries.filter((e) => e.targetTenantId === TENANT_ID);

    expect(own).toHaveLength(2);
    expect(own[0]?.action).toBe("sandbox.reset");
    expect(own[1]?.action).toBe("sandbox.created");
  });

  it("paginates strictly older than the given cursor, excluding the cursor row itself", async () => {
    await recordPlatformAdminAction({
      actorSub: "pa-2",
      action: "sandbox.deleted",
      targetTenantId: OTHER_TENANT_ID,
    });

    const page1 = await listPlatformAdminAuditLog({ limit: 1 });
    const cursorId = page1[0]?.id;
    expect(cursorId).toBeTruthy();

    const page2 = await listPlatformAdminAuditLog({
      limit: 50,
      before: cursorId,
    });

    expect(page2.find((e) => e.id === cursorId)).toBeUndefined();
  });

  it("returns an empty array for a well-formed but non-existent cursor, not an error", async () => {
    await expect(
      listPlatformAdminAuditLog({ limit: 50, before: MISSING_ENTRY_ID }),
    ).resolves.toEqual([]);
  });
});
