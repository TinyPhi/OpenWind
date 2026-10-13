import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerEvent } from "../event-schemas.js";

const insertedRows: Array<{ table: unknown; values: unknown }> = [];
let entityRow:
  | { assignedTo: string | null; workflowId: string | null; fields: unknown }
  | undefined = undefined;
let policyCandidates: Array<{
  id: string;
  teamId: string | null;
  workflowTypeId: string | null;
  channels: string[];
  notifyBackup: boolean;
  notifyEscalationManager: boolean;
}> = [];
let failChannelsOnInsert = new Set<string>();

const dbMock = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === "entity_instances_table") {
          return {
            limit: () => Promise.resolve(entityRow ? [entityRow] : []),
          };
        }
        if (table === "notification_policies_table") {
          return Promise.resolve(policyCandidates);
        }
        return Promise.resolve([]);
      },
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: { channel?: string }) => {
      onInsert?.();
      if (
        table === "notifications_table" &&
        values.channel &&
        failChannelsOnInsert.has(values.channel)
      ) {
        return {
          onConflictDoNothing: () => Promise.reject(new Error("insert failed")),
        };
      }
      insertedRows.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: "entity_instances_table",
  notificationPolicies: "notification_policies_table",
  notifications: "notifications_table",
  notificationRecipients: "notification_recipients_table",
  isOutboundNotificationsEnabled: () => Promise.resolve(true),
}));

const mockGetActiveScheduleForTeam = vi.fn();
vi.mock("@platform/teams", () => ({
  getActiveScheduleForTeam: (...args: unknown[]) =>
    mockGetActiveScheduleForTeam(...args),
}));

const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

let onInsert: (() => void) | undefined;
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockCounterAdd = vi.fn();
const mockDispatchDurationRecord = vi.fn();
const mockPolicyMatchAdd = vi.fn();
vi.mock("@platform/telemetry", () => ({
  Queue: class {
    add(...args: unknown[]) {
      return mockQueueAdd(...args);
    }
    close() {
      return Promise.resolve();
    }
  },
  notificationDispatchTotal: {
    add: (...args: unknown[]) => mockCounterAdd(...args),
  },
  notificationDispatchDurationSeconds: {
    record: (...args: unknown[]) => mockDispatchDurationRecord(...args),
  },
  notificationPolicyMatchTotal: {
    add: (...args: unknown[]) => mockPolicyMatchAdd(...args),
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeDispatchSeverityNotificationAction } =
  await import("./dispatch-severity-notification.js");

function redisMock(setResult: "OK" | null = "OK") {
  return {
    set: vi.fn().mockResolvedValue(setResult),
  } as never;
}

const TENANT_ID = "tenant-1";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("executeDispatchSeverityNotificationAction", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    entityRow = undefined;
    policyCandidates = [];
    failChannelsOnInsert = new Set();
    mockGetActiveScheduleForTeam.mockReset();
    mockWriteAuditEntry.mockClear();
    mockQueueAdd.mockClear();
    mockCounterAdd.mockClear();
    mockDispatchDurationRecord.mockClear();
    mockPolicyMatchAdd.mockClear();
    onInsert = undefined;
  });

  it("dispatches to the assignee on entity.created with severity set, falling back to the hardcoded email-only default when no policy matches", async () => {
    entityRow = { assignedTo: "u-assignee", workflowId: null, fields: {} };

    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.created",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      fields: { severity: "high" },
      createdBy: "u-creator",
    };

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(),
    );

    const notifRows = insertedRows.filter(
      (r) => r.table === "notifications_table",
    );
    expect(notifRows).toHaveLength(1);
    expect((notifRows[0]?.values as { channel: string }).channel).toBe("email");

    const recipientRows = insertedRows.filter(
      (r) => r.table === "notification_recipients_table",
    );
    expect(
      recipientRows.map((r) => (r.values as { userId: string }).userId),
    ).toEqual(["u-assignee"]);

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "notification.dispatched" }),
    );
  });

  it("does nothing on entity.updated when severity is not in the changed map", async () => {
    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.updated",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { priority: { old: "low", new: "high" } },
    };

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(),
    );

    expect(insertedRows).toHaveLength(0);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("no-ops on a stale entity.updated event with no `changed` field (PR #597 review, B1)", async () => {
    const event = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.updated",
      instanceId: INSTANCE_ID,
      actorId: "u-actor",
      // entityTypeId/changed both absent -- a pre-existing outbox row from
      // before entity.updated was added to the poller's allowlist.
    } as unknown as TriggerEvent;

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(),
    );

    expect(insertedRows).toHaveLength(0);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("dispatches on entity.updated when severity changed, including backup and escalation manager per policy flags", async () => {
    entityRow = {
      assignedTo: "u-assignee",
      workflowId: null,
      fields: { team_id: "team-1" },
    };
    policyCandidates = [
      {
        id: "policy-1",
        teamId: null,
        workflowTypeId: null,
        channels: ["email", "sms"],
        notifyBackup: true,
        notifyEscalationManager: false,
      },
    ];
    mockGetActiveScheduleForTeam.mockResolvedValue({
      id: "sched-1",
      teamId: "team-1",
      primaryUserId: "u-primary",
      backupUserId: "u-backup",
      escalationManagerUserId: "u-escalation",
    });

    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.updated",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { severity: { old: "low", new: "high" } },
    };

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(),
    );

    const recipientRows = insertedRows.filter(
      (r) => r.table === "notification_recipients_table",
    );
    const recipientIds = new Set(
      recipientRows.map((r) => (r.values as { userId: string }).userId),
    );
    expect(recipientIds).toEqual(new Set(["u-assignee", "u-backup"]));
    expect(recipientIds.has("u-escalation")).toBe(false); // notifyEscalationManager false, not critical
  });

  it("includes the escalation manager when severity is critical even if the policy doesn't request it", async () => {
    entityRow = {
      assignedTo: null,
      workflowId: null,
      fields: { team_id: "team-1" },
    };
    policyCandidates = [
      {
        id: "policy-1",
        teamId: null,
        workflowTypeId: null,
        channels: ["email"],
        notifyBackup: false,
        notifyEscalationManager: false,
      },
    ];
    mockGetActiveScheduleForTeam.mockResolvedValue({
      id: "sched-1",
      teamId: "team-1",
      primaryUserId: "u-primary",
      backupUserId: "u-backup",
      escalationManagerUserId: "u-escalation",
    });

    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.updated",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { severity: { old: "high", new: "critical" } },
    };

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(),
    );

    const recipientRows = insertedRows.filter(
      (r) => r.table === "notification_recipients_table",
    );
    const recipientIds = new Set(
      recipientRows.map((r) => (r.values as { userId: string }).userId),
    );
    expect(recipientIds).toEqual(new Set(["u-escalation"]));
  });

  it("isolates a per-channel failure — one failed channel does not suppress the others (R18)", async () => {
    entityRow = { assignedTo: "u-assignee", workflowId: null, fields: {} };
    policyCandidates = [
      {
        id: "policy-1",
        teamId: null,
        workflowTypeId: null,
        channels: ["email", "sms"],
        notifyBackup: false,
        notifyEscalationManager: false,
      },
    ];
    failChannelsOnInsert = new Set(["sms"]);

    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.created",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      fields: { severity: "high" },
      createdBy: "u-creator",
    };

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(),
    );

    const notifRows = insertedRows.filter(
      (r) => r.table === "notifications_table",
    );
    expect(notifRows).toHaveLength(1);
    expect((notifRows[0]?.values as { channel: string }).channel).toBe("email");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "notification.channel_failed",
        metadata: expect.objectContaining({ channel: "sms" }),
      }),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "notification.dispatched" }),
    );
  });

  it("is idempotent — a second delivery for the same (ticket, severity) pair is a no-op", async () => {
    entityRow = { assignedTo: "u-assignee", workflowId: null, fields: {} };

    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.created",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      fields: { severity: "high" },
      createdBy: "u-creator",
    };

    await executeDispatchSeverityNotificationAction(
      dbMock as never,
      TENANT_ID,
      event,
      {},
      redisMock(null),
    );

    expect(insertedRows).toHaveLength(0);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  describe("dispatch duration histogram and policy match counter (#570 T39)", () => {
    const event: TriggerEvent = {
      version: 1,
      tenantId: TENANT_ID,
      eventType: "entity.created",
      instanceId: INSTANCE_ID,
      entityTypeId: "et-1",
      fields: { severity: "high" },
      createdBy: "u-creator",
    };
    const run = (redis = redisMock()) =>
      executeDispatchSeverityNotificationAction(
        dbMock as never,
        TENANT_ID,
        event,
        {},
        redis,
      );
    const policy = (over: Record<string, unknown>) => ({
      id: "policy-1",
      teamId: null,
      workflowTypeId: null,
      channels: ["email"],
      notifyBackup: false,
      notifyEscalationManager: false,
      ...over,
    });

    beforeEach(() => {
      entityRow = { assignedTo: "u-assignee", workflowId: null, fields: {} };
    });

    it.each([
      ["no policy matches", [], "hardcoded_default"],
      ["a global policy matches", [policy({})], "global"],
      ["a team policy matches", [policy({ teamId: "team-1" })], "team"],
      [
        "a workflow policy matches",
        [policy({ workflowTypeId: "wf-1" })],
        "workflow",
      ],
      [
        "a team and workflow policy matches",
        [policy({ teamId: "team-1", workflowTypeId: "wf-1" })],
        "team_workflow",
      ],
    ])(
      "counts the policy match once, labelled matched_at, when %s",
      async (_label, candidates, expected) => {
        policyCandidates = candidates as typeof policyCandidates;

        await run();

        expect(mockPolicyMatchAdd).toHaveBeenCalledTimes(1);
        expect(mockPolicyMatchAdd).toHaveBeenCalledWith(1, {
          matched_at: expected,
        });
      },
    );

    it("does not count a policy match for an idempotent replay", async () => {
      await run(redisMock(null));

      expect(mockPolicyMatchAdd).not.toHaveBeenCalled();
      expect(mockDispatchDurationRecord).not.toHaveBeenCalled();
    });

    it("does not count a policy match when there is no recipient to send to", async () => {
      entityRow = { assignedTo: null, workflowId: null, fields: {} };

      await run();

      expect(mockPolicyMatchAdd).not.toHaveBeenCalled();
    });

    it("records one duration per channel, labelled by channel only, for an ok and a failed channel", async () => {
      policyCandidates = [policy({ channels: ["email", "sms"] })];
      failChannelsOnInsert = new Set(["sms"]);

      await run();

      expect(mockDispatchDurationRecord).toHaveBeenCalledTimes(2);
      const byChannel = new Map(
        mockDispatchDurationRecord.mock.calls.map((c) => [
          (c[1] as { channel: string }).channel,
          c as [number, Record<string, unknown>],
        ]),
      );
      expect([...byChannel.keys()].sort()).toEqual(["email", "sms"]);
      for (const [seconds, attrs] of byChannel.values()) {
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(Object.keys(attrs)).toEqual(["channel"]);
      }
      // The counter and the histogram agree on which channels were attempted.
      expect(mockCounterAdd).toHaveBeenCalledTimes(2);
    });

    it("times each channel separately, over the same work whether it succeeds or fails", async () => {
      let now = 1_000;
      const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
      try {
        onInsert = () => {
          now += 100;
        };
        policyCandidates = [policy({ channels: ["email", "sms"] })];
        failChannelsOnInsert = new Set(["sms"]);

        await run();

        const seconds = Object.fromEntries(
          mockDispatchDurationRecord.mock.calls.map((c) => [
            (c[1] as { channel: string }).channel,
            c[0] as number,
          ]),
        );
        // email makes two inserts (notification, recipient), sms one that rejects.
        expect(seconds["email"]).toBeCloseTo(0.2, 6);
        expect(seconds["sms"]).toBeCloseTo(0.1, 6);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
