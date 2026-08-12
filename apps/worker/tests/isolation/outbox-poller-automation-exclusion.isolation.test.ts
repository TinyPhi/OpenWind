/**
 * Regression test for PR #372 review finding C1: #143 made executeTransition
 * write a workflow.transitioned outbox row for triggeredBy === "automation"
 * too. Without an exclusion, this poller's existing workflow.transitioned
 * allowlist would claim that row and enqueue a SECOND, duplicate
 * executeAutomationRules call for a transition the sync in-process path
 * (packages/automation-engine/src/actions/transition.ts) already ran —
 * exactly the double-trigger regression #120 originally fixed. The exclusion
 * is temporary (removed once #143 Phase 2's consumer-side dedup lands) but
 * must hold until then.
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

const TENANT_ID = "cccccccc-0000-4000-c000-000000000372";
let automationRowId: string;
let userRowId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT_ID,
    name: "PR #372 outbox-poller exclusion test",
    slug: `pr372-poller-exclusion-${TENANT_ID}`,
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

describe("outbox-poller excludes automation-triggered transitions (#372 review C1)", () => {
  it("does not claim or enqueue an automation-triggered workflow.transitioned row, but does claim a user-triggered one", async () => {
    startOutboxPoller(50);

    // Poll instead of a fixed sleep — the poller processes BATCH_SIZE rows
    // per tick oldest-first, so any pre-existing backlog elsewhere in the
    // table (e.g. from other suites' fixtures) delays reaching this test's
    // own rows by an amount that isn't fixed. Bounded to 5s so a real bug
    // (the row never gets claimed at all) still fails the test promptly.
    let userRow: { deliveredAt: Date | null } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      [userRow] = await db
        .select({ deliveredAt: outboxEvents.deliveredAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, userRowId));
      if (userRow?.deliveredAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stopOutboxPoller();

    const [automationRow] = await db
      .select({ deliveredAt: outboxEvents.deliveredAt })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, automationRowId));

    expect(automationRow?.deliveredAt).toBeNull();
    expect(userRow?.deliveredAt).not.toBeNull();

    expect(mockAdd).not.toHaveBeenCalledWith(
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
