/**
 * Isolation tests for migration 0049: RLS on outbox_events and dead_letter_events,
 * and migration 0056 (PR #374 review H1): the NULL/empty-GUC batch-access exemption
 * these two tables need for apps/worker's cross-tenant pollers.
 *
 * Verifies that the database-level tenant isolation is correctly enforced
 * for reads, inserts, and updates when executing under the `app_user` role
 * with `app.tenant_id` context, AND that the same role can still batch across
 * every tenant's rows when no tenant context (NULL) or a placeholder empty
 * string ('', see 0056's migration comment for why this state exists) is set.
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
 * branch of the 0056 policy).
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
 * models the pgbouncer/set_config placeholder-GUC state described in 0056's
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

// 0056 (PR #374 review H1): the batch-access exemption apps/worker's pollers
// rely on — a connection with no tenant context (NULL, or the pgbouncer
// placeholder '') must see and update rows across every tenant, not just its
// own. Without this, the NULLIF-guarded ::uuid cast alone would only stop
// the RLS check from throwing; it would not actually grant batch access.
describe("outbox_events RLS policies — no-context batch access (0056)", () => {
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
