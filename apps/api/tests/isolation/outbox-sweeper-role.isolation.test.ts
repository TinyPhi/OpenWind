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
 * platform-wide.
 *
 * Two independent fixes for this same outage now both exist:
 * 0064_outbox_sweeper_role.sql (this repo's own direct-to-server hotfix,
 * predates PR #374) grants a narrowly-scoped BYPASSRLS role to the three
 * sweep call sites via SET LOCAL ROLE. 0058_outbox_dead_letter_rls_null_guc_fix.sql
 * (PR #374, merged later upstream) takes a broader approach: it widens the
 * RLS policy itself so ANY app_user connection with no tenant context (NULL
 * or the pgbouncer placeholder '') gets batch access, not just the three
 * call sites that opt into outbox_sweeper. Since 0058's policy is now the
 * effective one, plain app_user with no context correctly succeeds too —
 * outbox_sweeper is a redundant-but-harmless belt-and-suspenders mechanism
 * for exactly the three call sites that use it, not the sole gate anymore.
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
  it("sees both tenants' rows under plain app_user with no tenant context set (0058's broader fix)", async () => {
    // Superseded expectation, kept as a regression guard: before PR #374's
    // RLS-policy widening (0058), this exact scenario reproduced the
    // production outage documented above (0 rows / thrown error). It now
    // correctly succeeds without needing the outbox_sweeper role at all —
    // if this assertion ever fails again, 0058's policy has regressed.
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      return tx.execute<{ id: string; tenant_id: string }>(SWEEP_QUERY);
    });

    const tenantIds = new Set(rows.map((r) => r.tenant_id));
    expect(tenantIds.has(TENANT_A)).toBe(true);
    expect(tenantIds.has(TENANT_B)).toBe(true);
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
