/**
 * Reproduces the production outage caused by 0050_outbox_events_rls.sql:
 * outbox-poller.ts / notification-poller.ts sweep outbox_events across all
 * tenants in one query and can't set app.tenant_id (there is no single
 * tenant to scope a cross-tenant sweep to). Under app_user (NOBYPASSRLS),
 * with app.tenant_id unset the RLS USING clause's `::uuid` cast either
 * raises `invalid input syntax for type uuid` (observed in production logs,
 * likely a stale non-NULL GUC left on a pooled connection) or, on a clean
 * session where current_setting(...) returns NULL, silently filters every
 * row out — either way, the sweep never sees any tenant's events, so no
 * automation triggers or in-app/email notifications were delivered
 * platform-wide. The assertion below covers both manifestations rather
 * than assuming one specific error text.
 *
 * 0053_outbox_sweeper_role.sql fixes this with a narrowly-scoped BYPASSRLS
 * role, granted only inside the sweep transaction via SET LOCAL ROLE.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db, withTenantContext, outboxEvents } from "@platform/db";

const TENANT_A = "aaaaaaaa-0053-4000-a000-000000000053";
const TENANT_B = "bbbbbbbb-0053-4000-b000-000000000053";

beforeAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx.insert(outboxEvents).values({
      tenantId: TENANT_A,
      eventType: "entity.created",
      payload: { test: "A" },
    }),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.insert(outboxEvents).values({
      tenantId: TENANT_B,
      eventType: "entity.created",
      payload: { test: "B" },
    }),
  );
});

afterAll(async () => {
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_A));
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_B));
});

const SWEEP_QUERY = sql`
  SELECT id, tenant_id FROM outbox_events
  WHERE delivered_at IS NULL AND event_type = 'entity.created'
`;

describe("outbox_events cross-tenant sweep", () => {
  it("never sees both tenants' rows under app_user with no tenant context set (the production bug)", async () => {
    let rows: Array<{ id: string; tenant_id: string }> = [];
    try {
      rows = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        return tx.execute<{ id: string; tenant_id: string }>(SWEEP_QUERY);
      });
    } catch {
      // RLS blocking this cross-tenant sweep can surface as either a thrown
      // error (uuid cast failure) or, on a clean session, a silently empty
      // result — both are the bug; neither should ever return real rows.
    }

    expect(rows).toHaveLength(0);
  });

  it("succeeds and sees rows across tenants when running as outbox_sweeper", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SET LOCAL ROLE outbox_sweeper`);
      return tx.execute<{ id: string; tenant_id: string }>(SWEEP_QUERY);
    });

    const tenantIds = new Set(rows.map((r) => r.tenant_id));
    expect(tenantIds.has(TENANT_A)).toBe(true);
    expect(tenantIds.has(TENANT_B)).toBe(true);
  });
});
