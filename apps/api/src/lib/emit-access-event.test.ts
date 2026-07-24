import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => {
  const noop = vi.fn(() => "sql");
  return { eq: noop, and: noop, isNull: noop };
});

const workflowEventInserts: unknown[] = [];
const outboxEventInserts: unknown[] = [];

let instanceRow: {
  workflowId: string | null;
  currentState: string | null;
} | null = { workflowId: "wf-1", currentState: "open" };

const entityInstancesTable = { id: "entity_instances.id" };
const entityRelationsTable = {};
const workflowEventsTable = {};
const outboxEventsTable = {};

const mockTx = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () => Promise.resolve(instanceRow ? [instanceRow] : []),
  insert: (table: unknown) => ({
    values: (arg: unknown) => {
      if (table === workflowEventsTable) workflowEventInserts.push(arg);
      if (table === outboxEventsTable) outboxEventInserts.push(arg);
      return Promise.resolve(undefined);
    },
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: entityInstancesTable,
  entityRelations: entityRelationsTable,
  workflowEvents: workflowEventsTable,
  outboxEvents: outboxEventsTable,
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { emitAccessEvent } = await import("./emit-access-event.js");

describe("emitAccessEvent", () => {
  beforeEach(() => {
    workflowEventInserts.length = 0;
    outboxEventInserts.length = 0;
    instanceRow = { workflowId: "wf-1", currentState: "open" };
  });

  it("writes an access.granted outbox event for an access_grant", async () => {
    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_grant",
      targetUserId: "u-target",
      level: "read_write",
    });

    expect(workflowEventInserts.length).toBe(1);
    expect(outboxEventInserts.length).toBe(1);
    expect(outboxEventInserts[0]).toMatchObject({
      tenantId: "t-aaa",
      eventType: "access.granted",
      version: 1,
      payload: {
        eventType: "access.granted",
        tenantId: "t-aaa",
        instanceId: "inst-1",
        actorId: "u-actor",
        targetUserId: "u-target",
      },
    });
  });

  it("writes an access.revoked outbox event for an access_revoke", async () => {
    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_revoke",
      targetUserId: "u-target",
    });

    expect(outboxEventInserts.length).toBe(1);
    expect(outboxEventInserts[0]).toMatchObject({
      eventType: "access.revoked",
      payload: { targetUserId: "u-target" },
    });
  });

  it("does not write an outbox event for access_update or access_reject", async () => {
    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_update",
      targetUserId: "u-target",
      level: "read_only",
      oldLevel: "read_write",
    });
    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_reject",
      targetUserId: "u-target",
    });

    expect(workflowEventInserts.length).toBe(2);
    expect(outboxEventInserts.length).toBe(0);
  });

  it("writes neither event when the instance has no resolvable workflow", async () => {
    instanceRow = { workflowId: null, currentState: null };

    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_grant",
      targetUserId: "u-target",
    });

    expect(workflowEventInserts.length).toBe(0);
    expect(outboxEventInserts.length).toBe(0);
  });
});
