/**
 * Regression test for #378: PR #372 review finding C1 added a temporary
 * exclusion so this poller's query would skip workflow.transitioned rows
 * with payload->>'triggeredBy' = 'automation', to avoid double-triggering
 * rules that transition.ts already ran synchronously in-process (#120).
 * That exclusion is no longer needed now that #143 Phase 2 shipped
 * consumer-side dedup (executor.ts's advisory-lock + status = 'success'
 * check, keyed on (ruleId, transitionEventId)) — the exclusion was removed
 * from outbox-poller.ts, and this test now asserts the OPPOSITE of what it
 * asserted before: the poller claims and enqueues automation-triggered rows
 * exactly like any other workflow.transitioned row.
 *
 * See outbox-poller-automation-dedup-race.isolation.test.ts for the fuller
 * regression proving the dedup itself still holds when both the sync
 * in-process path and this poller's async re-delivery of the same outbox
 * row are exercised together.
 *
 * Uses a real Postgres database (no mocks on @platform/db), matching the
 * apps/worker isolation test convention — mocking the database is prohibited
 * per testing-conventions.md. Only ./queues.js (BullMQ) is mocked, so the
 * poller's SQL query is exercised for real without needing a live queue.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants, outboxEvents } from "@platform/db";

const mockAdd = vi.fn();

vi.mock("../../src/queues.js", () => ({
  automationQueue: { add: (...args: unknown[]) => mockAdd(...args) },
}));

const { startOutboxPoller, stopOutboxPoller } =
  await import("../../src/outbox-poller.js");

const TENANT_ID = "cccccccc-0000-4000-c000-000000000378";
let automationRowId: string;
let userRowId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT_ID,
    name: "#378 outbox-poller inclusion test",
    slug: `pr378-poller-inclusion-${TENANT_ID}`,
  });

  const [automationRow] = await db
    .insert(outboxEvents)
    .values({
      tenantId: TENANT_ID,
      eventType: "workflow.transitioned",
      version: 1,
      payload: {
        eventType: "workflow.transitioned",
        triggeredBy: "automation",
      },
    })
    .returning({ id: outboxEvents.id });
  if (!automationRow) throw new Error("automation row insert failed");
  automationRowId = automationRow.id;

  const [userRow] = await db
    .insert(outboxEvents)
    .values({
      tenantId: TENANT_ID,
      eventType: "workflow.transitioned",
      version: 1,
      payload: { eventType: "workflow.transitioned", triggeredBy: "user" },
    })
    .returning({ id: outboxEvents.id });
  if (!userRow) throw new Error("user row insert failed");
  userRowId = userRow.id;
});

afterAll(async () => {
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("outbox-poller no longer excludes automation-triggered transitions (#378)", () => {
  it("claims and enqueues both an automation-triggered and a user-triggered workflow.transitioned row", async () => {
    startOutboxPoller(50);

    // Poll instead of a fixed sleep — the poller processes BATCH_SIZE rows
    // per tick oldest-first, so any pre-existing backlog elsewhere in the
    // table (e.g. from other suites' fixtures) delays reaching this test's
    // own rows by an amount that isn't fixed. Bounded to 5s so a real bug
    // (a row never gets claimed at all) still fails the test promptly.
    let automationRow: { deliveredAt: Date | null } | undefined;
    let userRow: { deliveredAt: Date | null } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      [automationRow] = await db
        .select({ deliveredAt: outboxEvents.deliveredAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, automationRowId));
      [userRow] = await db
        .select({ deliveredAt: outboxEvents.deliveredAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, userRowId));
      if (automationRow?.deliveredAt && userRow?.deliveredAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stopOutboxPoller();

    expect(automationRow?.deliveredAt).not.toBeNull();
    expect(userRow?.deliveredAt).not.toBeNull();

    expect(mockAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outboxEventId: automationRowId }),
      expect.anything(),
    );
    expect(mockAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outboxEventId: userRowId }),
      expect.anything(),
    );
  });
});
