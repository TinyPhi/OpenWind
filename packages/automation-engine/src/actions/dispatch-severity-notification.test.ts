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

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockCounterAdd = vi.fn();
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
});
