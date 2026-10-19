/**
 * #993: paging `platform_admin_audit_log` with `before`. The cursor row's created_at used to be read
 * back as a JavaScript Date (millisecond precision) and compared with the stored microsecond
 * timestamps, so a row between the truncated value and the cursor row's real value fell through both
 * branches of the keyset predicate and was skipped.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  platformAdminAuditLog,
  listPlatformAdminAuditLog,
} from "@platform/db";

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

async function insertAt(
  timestamp: string,
  targetTenantId: string = TENANT,
): Promise<string> {
  const [row] = await db
    .insert(platformAdminAuditLog)
    .values({
      actorSub: "pa-cursor-test",
      action: "sandbox.created",
      targetTenantId,
      createdAt: sql`${timestamp}::timestamptz`,
    })
    .returning({ id: platformAdminAuditLog.id });
  return row!.id;
}

async function pageThrough(limit: number): Promise<string[]> {
  const ids: string[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await listPlatformAdminAuditLog({
      limit,
      before,
      targetTenantId: TENANT,
    });
    if (page.length === 0) break;
    ids.push(...page.map((entry) => entry.id));
    before = page[page.length - 1]!.id;
  }
  return ids;
}

afterAll(async () => {
  for (const tenantId of [TENANT, OTHER_TENANT]) {
    await db
      .delete(platformAdminAuditLog)
      .where(eq(platformAdminAuditLog.targetTenantId, tenantId));
  }
});

describe("listPlatformAdminAuditLog keyset paging (#993)", () => {
  it("returns every row, newest first, when rows share a millisecond and differ in microseconds", async () => {
    const newest = await insertAt("2031-03-01T10:00:00.002000Z");
    const a = await insertAt("2031-03-01T10:00:00.000900Z");
    const b = await insertAt("2031-03-01T10:00:00.000500Z");
    const c = await insertAt("2031-03-01T10:00:00.000100Z");
    const oldest = await insertAt("2031-03-01T09:59:59.999000Z");

    expect(await pageThrough(2)).toEqual([newest, a, b, c, oldest]);
    expect(await pageThrough(1)).toEqual([newest, a, b, c, oldest]);
  });

  it("keeps rows with an identical timestamp apart by id, without skipping or repeating", async () => {
    const x = await insertAt("2031-04-01T10:00:00.000300Z");
    const y = await insertAt("2031-04-01T10:00:00.000300Z");
    const z = await insertAt("2031-04-01T10:00:00.000300Z");

    const paged = (await pageThrough(1)).filter((id) => [x, y, z].includes(id));
    expect(paged).toHaveLength(3);
    expect(new Set(paged).size).toBe(3);
    expect(paged).toEqual([...paged].sort().reverse());
  });

  it("returns no rows for a cursor id that does not exist", async () => {
    expect(
      await listPlatformAdminAuditLog({
        limit: 10,
        before: randomUUID(),
        targetTenantId: TENANT,
      }),
    ).toEqual([]);
  });

  it("applies the tenant filter while paging", async () => {
    const mine = await insertAt("2031-05-01T10:00:00.000800Z");
    await insertAt("2031-05-01T10:00:00.000700Z", OTHER_TENANT);
    const older = await insertAt("2031-05-01T10:00:00.000600Z");

    const page = await listPlatformAdminAuditLog({
      limit: 10,
      before: mine,
      targetTenantId: TENANT,
    });
    expect(page.map((entry) => entry.id)).toContain(older);
    expect(page.every((entry) => entry.targetTenantId === TENANT)).toBe(true);
  });
});
