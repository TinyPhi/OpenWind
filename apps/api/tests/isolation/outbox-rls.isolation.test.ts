/**
 * Isolation tests for migration 0049: RLS on outbox_events and dead_letter_events.
 *
 * Verifies that the database-level tenant isolation is correctly enforced
 * for reads, inserts, and updates when executing under the `app_user` role
 * with `app.tenant_id` context.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  outboxEvents,
  deadLetterEvents,
} from "@platform/db";

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
