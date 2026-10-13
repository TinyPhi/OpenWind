/**
 * Audit `action` filter on queryAuditLog — behaviour and tenant isolation.
 *
 * Runs against a real Postgres with migrations applied. Reads go through
 * withTenantContext (SET LOCAL ROLE app_user), so RLS is active as well as the
 * explicit tenant_id condition queryAuditLog always adds.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenantContext, adminAuditLog } from "@platform/db";
import { queryAuditLog, type AuditAction } from "@platform/audit";

const TENANT_A = "ffffffff-3333-4000-f000-000000000001";
const TENANT_B = "ffffffff-3333-4000-f000-000000000002";

// Tenant B deliberately reuses tenant A's ticket id: a filter that leaked by
// resource id alone would show it.
const TICKET_1 = "ffffffff-3333-4000-f000-000000000101";
const TICKET_2 = "ffffffff-3333-4000-f000-000000000102";

const HOUR = 3_600_000;
const ago = (hours: number): Date => new Date(Date.now() - hours * HOUR);

function entry(
  tenantId: string,
  resourceId: string,
  action: AuditAction,
  createdAt: Date,
): typeof adminAuditLog.$inferInsert {
  return {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: "ticket",
    resourceId,
    action,
    createdAt,
  };
}

beforeAll(async () => {
  await db
    .insert(adminAuditLog)
    .values([
      entry(TENANT_A, TICKET_1, "notification.channel_failed", ago(1)),
      entry(TENANT_A, TICKET_1, "notification.channel_failed", ago(30)),
      entry(TENANT_A, TICKET_2, "notification.channel_failed", ago(2)),
      entry(TENANT_A, TICKET_1, "ticket.view_denied", ago(3)),
      entry(TENANT_A, TICKET_1, "access.revoked", ago(4)),
      entry(TENANT_B, TICKET_1, "notification.channel_failed", ago(1)),
    ]);
});

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_A));
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_B));
});

const asTenantA = (input: Parameters<typeof queryAuditLog>[1]) =>
  withTenantContext(TENANT_A, (tx) => queryAuditLog(tx, input));

describe("queryAuditLog action filter", () => {
  it("returns only entries with the given action", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_A,
      action: "notification.channel_failed",
    });

    expect(entries).toHaveLength(3);
    expect(
      entries.every((e) => e.action === "notification.channel_failed"),
    ).toBe(true);
  });

  it("returns the union when given several actions", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_A,
      action: ["notification.channel_failed", "access.revoked"],
    });

    expect(entries.map((e) => e.action).sort()).toEqual([
      "access.revoked",
      "notification.channel_failed",
      "notification.channel_failed",
      "notification.channel_failed",
    ]);
  });

  it("narrows further with the resource filters", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_A,
      action: "notification.channel_failed",
      resourceType: "ticket",
      resourceId: TICKET_1,
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.resourceId === TICKET_1)).toBe(true);
  });

  it("narrows further with a time window: the per-ticket, last-24-hours shape", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_A,
      action: "notification.channel_failed",
      resourceType: "ticket",
      resourceId: TICKET_1,
      from: ago(24),
    });

    expect(entries).toHaveLength(1);
  });

  it("intersects with outcome rather than replacing it", async () => {
    const denied = await asTenantA({
      tenantId: TENANT_A,
      action: "ticket.view_denied",
      outcome: "denied",
    });
    const allowed = await asTenantA({
      tenantId: TENANT_A,
      action: "ticket.view_denied",
      outcome: "allowed",
    });
    const wrongSet = await asTenantA({
      tenantId: TENANT_A,
      action: "notification.channel_failed",
      outcome: "denied",
    });

    expect(denied.entries).toHaveLength(1);
    expect(allowed.entries).toHaveLength(0);
    expect(wrongSet.entries).toHaveLength(0);
  });

  it("matches nothing for an empty list, without error", async () => {
    const result = await asTenantA({ tenantId: TENANT_A, action: [] });

    expect(result).toEqual({ entries: [], nextCursor: null });
  });

  it("returns nothing for an action this tenant has no entries for", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_A,
      action: "sandbox.reset_completed",
    });

    expect(entries).toHaveLength(0);
  });

  it("pages through filtered results without mixing in other actions", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await asTenantA({
        tenantId: TENANT_A,
        action: "notification.channel_failed",
        limit: 1,
        cursor,
      });
      seen.push(...result.entries.map((e) => e.action));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen).toEqual([
      "notification.channel_failed",
      "notification.channel_failed",
      "notification.channel_failed",
    ]);
  });
});

describe("queryAuditLog action filter — tenant isolation", () => {
  it("never returns another tenant's entry, even for the same action and resource id", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_A,
      action: "notification.channel_failed",
      resourceType: "ticket",
      resourceId: TICKET_1,
    });

    // Tenant A has two such entries; tenant B's third one (same action, same
    // ticket id) must not be among them.
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });

  it("returns tenant B its own entry for that action and resource id", async () => {
    const { entries } = await withTenantContext(TENANT_B, (tx) =>
      queryAuditLog(tx, {
        tenantId: TENANT_B,
        action: "notification.channel_failed",
        resourceType: "ticket",
        resourceId: TICKET_1,
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.tenantId).toBe(TENANT_B);
  });

  it("lets RLS hide tenant B's rows from a tenant A session even when the explicit filter asks for them", async () => {
    const { entries } = await asTenantA({
      tenantId: TENANT_B,
      action: "notification.channel_failed",
    });

    expect(entries).toHaveLength(0);
  });
});
