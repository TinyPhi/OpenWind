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

const {
  emitAccessEvent,
  emitAccessRequestSubmitted,
  emitFileDownloaded,
  emitFileDeleted,
} = await import("./emit-access-event.js");

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

  it("writes an access.updated outbox event for an access_update (§2.3)", async () => {
    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_update",
      targetUserId: "u-target",
      level: "read_only",
      oldLevel: "read_write",
    });

    expect(workflowEventInserts.length).toBe(1);
    expect(outboxEventInserts.length).toBe(1);
    expect(outboxEventInserts[0]).toMatchObject({
      eventType: "access.updated",
      payload: { targetUserId: "u-target" },
    });
  });

  it("does not write an outbox event for access_reject — only the requester is notified, via access_request.updated", async () => {
    await emitAccessEvent("t-aaa", "inst-1", "u-actor", {
      type: "access_reject",
      targetUserId: "u-target",
    });

    expect(workflowEventInserts.length).toBe(1);
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

describe("emitAccessRequestSubmitted (§3.6)", () => {
  beforeEach(() => {
    workflowEventInserts.length = 0;
    outboxEventInserts.length = 0;
    instanceRow = { workflowId: "wf-1", currentState: "open" };
  });

  it("writes a workflow_events row with the requester as actor, never an outbox event", async () => {
    await emitAccessRequestSubmitted(
      "t-aaa",
      "inst-1",
      "u-requester",
      "read_write",
    );

    expect(workflowEventInserts.length).toBe(1);
    expect(workflowEventInserts[0]).toMatchObject({
      tenantId: "t-aaa",
      instanceId: "inst-1",
      actorId: "u-requester",
      metadata: { type: "access_request", level: "read_write" },
    });
    // Deliberately no notification here — 2.9 already notifies
    // creator/assignedTo via its own access_request.created outbox write in
    // request-access.ts; this function only covers the history line.
    expect(outboxEventInserts.length).toBe(0);
  });

  it("writes nothing when the instance has no resolvable workflow", async () => {
    instanceRow = { workflowId: null, currentState: null };

    await emitAccessRequestSubmitted(
      "t-aaa",
      "inst-1",
      "u-requester",
      "read_only",
    );

    expect(workflowEventInserts.length).toBe(0);
  });
});

describe("emitFileDownloaded (§3.4)", () => {
  beforeEach(() => {
    workflowEventInserts.length = 0;
    outboxEventInserts.length = 0;
    instanceRow = { workflowId: "wf-1", currentState: "open" };
  });

  it("writes a file_downloaded workflow_events row, never an outbox event", async () => {
    await emitFileDownloaded(
      "t-aaa",
      "inst-1",
      "u-viewer",
      "file-1",
      "report.pdf",
    );

    expect(workflowEventInserts.length).toBe(1);
    expect(workflowEventInserts[0]).toMatchObject({
      tenantId: "t-aaa",
      instanceId: "inst-1",
      actorId: "u-viewer",
      metadata: {
        type: "file_downloaded",
        fileId: "file-1",
        originalName: "report.pdf",
      },
    });
    expect(outboxEventInserts.length).toBe(0);
  });

  it("writes nothing when the instance has no resolvable workflow", async () => {
    instanceRow = { workflowId: null, currentState: null };

    await emitFileDownloaded(
      "t-aaa",
      "inst-1",
      "u-viewer",
      "file-1",
      "report.pdf",
    );

    expect(workflowEventInserts.length).toBe(0);
  });
});

describe("emitFileDeleted (§3.5)", () => {
  beforeEach(() => {
    workflowEventInserts.length = 0;
    outboxEventInserts.length = 0;
    instanceRow = { workflowId: "wf-1", currentState: "open" };
  });

  it("writes a file_deleted workflow_events row, never an outbox event", async () => {
    await emitFileDeleted("t-aaa", "inst-1", "u-admin", "file-1", "report.pdf");

    expect(workflowEventInserts.length).toBe(1);
    expect(workflowEventInserts[0]).toMatchObject({
      tenantId: "t-aaa",
      instanceId: "inst-1",
      actorId: "u-admin",
      metadata: {
        type: "file_deleted",
        fileId: "file-1",
        originalName: "report.pdf",
      },
    });
    expect(outboxEventInserts.length).toBe(0);
  });
});
