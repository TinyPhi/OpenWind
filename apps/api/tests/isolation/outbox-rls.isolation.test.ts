/**
 * Isolation tests for migration 0049: RLS on outbox_events and dead_letter_events,
 * and migration 0058: the NULL/empty-GUC batch-access exemption these two tables
 * need for apps/worker's cross-tenant pollers.
 *
 * Verifies that the database-level tenant isolation is correctly enforced
 * for reads, inserts, and updates when executing under the `app_user` role
 * with `app.tenant_id` context, AND that the same role can still batch across
 * every tenant's rows when no tenant context (NULL) or a placeholder empty
 * string ('', see 0058's migration comment for why this state exists) is set.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  outboxEvents,
  deadLetterEvents,
} from "@platform/db";

/**
 * Runs `fn` as `app_user` with `app.tenant_id` never set on this transaction
 * — models a fresh backend that has never touched the GUC (the `IS NULL`
 * branch of the 0058 policy).
 */
function withAppUserNoGuc<T>(
  fn: Parameters<typeof db.transaction<T>>[0],
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    return fn(tx);
  });
}

/**
 * Runs `fn` as `app_user` with `app.tenant_id` explicitly set to '' —
 * models the pgbouncer/set_config placeholder-GUC state described in 0058's
 * migration comment (a backend that previously ran a real tenant context and
 * now has the GUC pinned to an empty string rather than reset to NULL).
 */
function withAppUserEmptyGuc<T>(
  fn: Parameters<typeof db.transaction<T>>[0],
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_user`);
    await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
    return fn(tx);
  });
}

const TENANT_A = "aaaaaaaa-0049-4000-a000-000000000049";
const TENANT_B = "bbbbbbbb-0049-4000-b000-000000000049";

let outboxIdA: string;
let outboxIdB: string;

beforeAll(async () => {
  // Seed outboxEvents for both tenants.
  const [obA] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(outboxEvents)
      .values({
        tenantId: TENANT_A,
        eventType: "entity.created",
        payload: { test: "A" },
      })
      .returning(),
  );
  if (!obA) throw new Error("outbox A insert failed");
  outboxIdA = obA.id;

  const [obB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(outboxEvents)
      .values({
        tenantId: TENANT_B,
        eventType: "entity.created",
        payload: { test: "B" },
      })
      .returning(),
  );
  if (!obB) throw new Error("outbox B insert failed");
  outboxIdB = obB.id;
});

afterAll(async () => {
  // Clean up using the bypass superuser client
  await db
    .delete(deadLetterEvents)
    .where(eq(deadLetterEvents.tenantId, TENANT_A));
  await db
    .delete(deadLetterEvents)
    .where(eq(deadLetterEvents.tenantId, TENANT_B));
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_A));
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_B));
});

describe("outbox_events RLS policies", () => {
  it("a tenant can read its own outbox events but not another tenant's", async () => {
    const own = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, outboxIdA)),
    );
    expect(own).toHaveLength(1);

    const cross = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, outboxIdB)),
    );
    expect(cross).toHaveLength(0);
  });

  it("a tenant cannot write an outbox event under another tenant's tenant_id", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(outboxEvents).values({
          tenantId: TENANT_B,
          eventType: "entity.created",
          payload: { test: "hijack" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot update another tenant's outbox event", async () => {
    const res = await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(outboxEvents)
        .set({ eventType: "hijacked" })
        .where(eq(outboxEvents.id, outboxIdB))
        .returning(),
    );
    expect(res).toHaveLength(0);
  });
});

// 0058: the batch-access exemption apps/worker's pollers rely on — a
// connection with no tenant context (NULL, or the pgbouncer placeholder '')
// must see and update rows across every tenant, not just its own. Without
// this, the NULLIF-guarded ::uuid cast alone would only stop the RLS check
// from throwing; it would not actually grant batch access.
describe("outbox_events RLS policies — no-context batch access (0058)", () => {
  it("SELECT across tenants succeeds when the GUC was never set (NULL)", async () => {
    const rows = await withAppUserNoGuc((tx) =>
      tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(sql`${outboxEvents.id} IN (${outboxIdA}, ${outboxIdB})`),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([outboxIdA, outboxIdB].sort());
  });

  it("SELECT across tenants succeeds when the GUC is the '' placeholder", async () => {
    const rows = await withAppUserEmptyGuc((tx) =>
      tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(sql`${outboxEvents.id} IN (${outboxIdA}, ${outboxIdB})`),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([outboxIdA, outboxIdB].sort());
  });

  it("UPDATE on another tenant's row succeeds when the GUC was never set (NULL)", async () => {
    const updated = await withAppUserNoGuc((tx) =>
      tx
        .update(outboxEvents)
        .set({ eventType: "batch-touched" })
        .where(eq(outboxEvents.id, outboxIdB))
        .returning({ id: outboxEvents.id }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe(outboxIdB);

    // Revert so later tests in this file see the original seeded eventType.
    await db
      .update(outboxEvents)
      .set({ eventType: "entity.created" })
      .where(eq(outboxEvents.id, outboxIdB));
  });

  it("UPDATE on another tenant's row succeeds when the GUC is the '' placeholder", async () => {
    const updated = await withAppUserEmptyGuc((tx) =>
      tx
        .update(outboxEvents)
        .set({ eventType: "batch-touched" })
        .where(eq(outboxEvents.id, outboxIdA))
        .returning({ id: outboxEvents.id }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]?.id).toBe(outboxIdA);

    // Revert so later tests in this file see the original seeded eventType.
    await db
      .update(outboxEvents)
      .set({ eventType: "entity.created" })
      .where(eq(outboxEvents.id, outboxIdA));
  });
});

describe("dead_letter_events RLS policies", () => {
  it("a tenant can write and read its own dead letter events but not another tenant's", async () => {
    const [dlA] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(deadLetterEvents)
        .values({
          tenantId: TENANT_A,
          eventType: "entity.created",
          payload: { test: "DL-A" },
          originalEventId: outboxIdA,
          error: "some error message",
          attemptCount: 1,
        })
        .returning(),
    );
    expect(dlA).toBeDefined();

    const [dlB] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .insert(deadLetterEvents)
        .values({
          tenantId: TENANT_B,
          eventType: "entity.created",
          payload: { test: "DL-B" },
          originalEventId: outboxIdB,
          error: "some error message",
          attemptCount: 1,
        })
        .returning(),
    );
    expect(dlB).toBeDefined();

    const own = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(deadLetterEvents).where(eq(deadLetterEvents.id, dlA.id)),
    );
    expect(own).toHaveLength(1);

    const cross = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(deadLetterEvents).where(eq(deadLetterEvents.id, dlB.id)),
    );
    expect(cross).toHaveLength(0);
  });

  it("a tenant cannot write a dead letter event under another tenant's tenant_id", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(deadLetterEvents).values({
          tenantId: TENANT_B,
          eventType: "entity.created",
          payload: { test: "hijack" },
          error: "some error message",
          attemptCount: 1,
        }),
      ),
    ).rejects.toThrow();
  });
});

// 0058: dead_letter_events shares the same policy shape as outbox_events — the
// no-context batch exemption must work here too. The primary concern is INSERT:
// notification-outbound-worker.ts writes a system.error dead-letter row on a
// permanently-failed outbound handoff with NO tenant context (its own comment
// documented "RLS disabled by design" relying on 0006 — migration 0049 broke
// that INSERT because `tenant_id = NULL::uuid` is NULL, and WITH CHECK treats
// NULL as a rejection). Migration 0058 restores the exemption.
describe("dead_letter_events RLS policies — no-context batch access (0058)", () => {
  let dlIdA: string;
  let dlIdB: string;

  beforeAll(async () => {
    const [a] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(deadLetterEvents)
        .values({
          tenantId: TENANT_A,
          eventType: "entity.created",
          payload: { test: "DL-batch-A" },
          originalEventId: outboxIdA,
          error: "test error",
          attemptCount: 1,
        })
        .returning(),
    );
    if (!a) throw new Error("dead_letter seed A failed");
    dlIdA = a.id;

    const [b] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .insert(deadLetterEvents)
        .values({
          tenantId: TENANT_B,
          eventType: "entity.created",
          payload: { test: "DL-batch-B" },
          originalEventId: outboxIdB,
          error: "test error",
          attemptCount: 1,
        })
        .returning(),
    );
    if (!b) throw new Error("dead_letter seed B failed");
    dlIdB = b.id;
  });

  it("SELECT across tenants succeeds when the GUC was never set (NULL)", async () => {
    const rows = await withAppUserNoGuc((tx) =>
      tx
        .select({ id: deadLetterEvents.id })
        .from(deadLetterEvents)
        .where(sql`${deadLetterEvents.id} IN (${dlIdA}, ${dlIdB})`),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([dlIdA, dlIdB].sort());
  });

  it("SELECT across tenants succeeds when the GUC is the '' placeholder", async () => {
    const rows = await withAppUserEmptyGuc((tx) =>
      tx
        .select({ id: deadLetterEvents.id })
        .from(deadLetterEvents)
        .where(sql`${deadLetterEvents.id} IN (${dlIdA}, ${dlIdB})`),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([dlIdA, dlIdB].sort());
  });

  it("INSERT with an explicit tenant_id succeeds when the GUC was never set (NULL)", async () => {
    // Models notification-outbound-worker.ts's system.error dead-letter insert
    // which runs with no tenant context — this INSERT was broken by migration
    // 0049's bare ::uuid cast (NULL GUC → NULL::uuid → WITH CHECK rejects).
    const [row] = await withAppUserNoGuc((tx) =>
      tx
        .insert(deadLetterEvents)
        .values({
          tenantId: TENANT_A,
          eventType: "system.error",
          payload: { error: "outbound delivery failed" },
          originalEventId: outboxIdA,
          error: "permanent failure",
          attemptCount: 3,
        })
        .returning({ id: deadLetterEvents.id }),
    );
    expect(row).toBeDefined();
    expect(row?.id).toBeTruthy();
  });

  it("INSERT with an explicit tenant_id succeeds when the GUC is the '' placeholder", async () => {
    const [row] = await withAppUserEmptyGuc((tx) =>
      tx
        .insert(deadLetterEvents)
        .values({
          tenantId: TENANT_B,
          eventType: "system.error",
          payload: { error: "outbound delivery failed" },
          originalEventId: outboxIdB,
          error: "permanent failure",
          attemptCount: 3,
        })
        .returning({ id: deadLetterEvents.id }),
    );
    expect(row).toBeDefined();
    expect(row?.id).toBeTruthy();
  });
});
