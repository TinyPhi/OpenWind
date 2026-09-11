import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerEvent } from "../event-schemas.js";

const insertedRows: Array<{ table: unknown; values: unknown }> = [];
let entityRow: { assignedTo: string | null } | undefined = undefined;

const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(entityRow ? [entityRow] : []),
      }),
    }),
  }),
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      insertedRows.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: "entity_instances_table",
  notifications: "notifications_table",
  notificationRecipients: "notification_recipients_table",
  isOutboundNotificationsEnabled: () => Promise.resolve(true),
}));

const mockUpdateEntity = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/entity-engine", () => ({
  updateEntity: (...args: unknown[]) => mockUpdateEntity(...args),
}));

const mockGetActiveScheduleForTeam = vi.fn();
const mockResolveOncallCascade = vi.fn();
vi.mock("@platform/teams", () => ({
  getActiveScheduleForTeam: (...args: unknown[]) =>
    mockGetActiveScheduleForTeam(...args),
  resolveOncallCascade: (...args: unknown[]) =>
    mockResolveOncallCascade(...args),
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
  },
  oncallResolutionsTotal: {
    add: (...args: unknown[]) => mockCounterAdd(...args),
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeResolveOncallAction } = await import("./resolve-oncall.js");

const SCHEDULE = {
  id: "sched-1",
  teamId: "team-1",
  primaryUserId: "u-primary",
  backupUserId: "u-backup",
  escalationManagerUserId: "u-escalation",
};

function redisMock(setResult: "OK" | null = "OK") {
  return {
    set: vi.fn().mockResolvedValue(setResult),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
  } as never;
}

const RULE_ID = "rule-1";
const EXEC_ID = "exec-1";

describe("executeResolveOncallAction", () => {
  beforeEach(() => {
    insertedRows.length = 0;
    entityRow = undefined;
    mockUpdateEntity.mockClear();
    mockGetActiveScheduleForTeam.mockReset();
    mockResolveOncallCascade.mockReset();
    mockWriteAuditEntry.mockClear();
    mockQueueAdd.mockClear();
    mockCounterAdd.mockClear();
  });

  it("auto-assigns to primary on entity.created with team_id set and no explicit assignee", async () => {
    entityRow = { assignedTo: null };
    mockGetActiveScheduleForTeam.mockResolvedValue(SCHEDULE);
    mockResolveOncallCascade.mockResolvedValue({
      tier: "primary",
      userId: "u-primary",
    });

    const event = {
      eventType: "entity.created",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      fields: { team_id: "team-1" },
      createdBy: "u-creator",
    } as unknown as TriggerEvent;

    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redisMock(),
    );

    expect(mockUpdateEntity).toHaveBeenCalledWith(
      dbMock,
      "t-1",
      "inst-1",
      expect.objectContaining({ assignedTo: "u-primary" }),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      dbMock,
      expect.objectContaining({
        action: "oncall.auto_assigned",
        metadata: expect.objectContaining({ assignedTier: "primary" }),
      }),
    );
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      outcome: "auto_assigned",
      assigned_tier: "primary",
    });
    // Backup notification: backup exists and resolved tier isn't backup.
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]?.table).toBe("notifications_table");
  });

  it("falls back to backup tier (R8b) and skips the backup notification (already the assignee)", async () => {
    entityRow = { assignedTo: null };
    mockGetActiveScheduleForTeam.mockResolvedValue(SCHEDULE);
    mockResolveOncallCascade.mockResolvedValue({
      tier: "backup",
      userId: "u-backup",
    });

    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { team_id: { old: null, new: "team-1" } },
    } as unknown as TriggerEvent;

    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redisMock(),
    );

    expect(mockUpdateEntity).toHaveBeenCalledWith(
      dbMock,
      "t-1",
      "inst-1",
      expect.objectContaining({ assignedTo: "u-backup" }),
    );
    expect(insertedRows).toHaveLength(0); // no double-notification to backup
  });

  it("skips resolution and audits oncall.skipped_explicit_assignee when assignee changed in the same update (R10)", async () => {
    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: {
        team_id: { old: null, new: "team-1" },
        assignedTo: { old: null, new: "u-explicit" },
      },
    } as unknown as TriggerEvent;

    const redis = redisMock();
    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redis,
    );

    expect(mockGetActiveScheduleForTeam).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      dbMock,
      expect.objectContaining({ action: "oncall.skipped_explicit_assignee" }),
    );
    expect(mockUpdateEntity).not.toHaveBeenCalled();
    // PR #597 review, B1: the idempotency key must be claimed even on this
    // early-return path -- a BullMQ retry that re-queries the same
    // still-non-null assignedTo must not write a second audit row.
    expect(redis.set).toHaveBeenCalledWith(
      "oncall_resolve:inst-1:team-1",
      "1",
      "EX",
      86400,
      "NX",
    );
  });

  it("is idempotent on the explicit-assignee-wins path — a second delivery is a no-op (R11/B1)", async () => {
    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: {
        team_id: { old: null, new: "team-1" },
        assignedTo: { old: null, new: "u-explicit" },
      },
    } as unknown as TriggerEvent;

    const redis = redisMock(null); // NX claim fails: already processed
    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redis,
    );

    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it("audits oncall.no_schedule (fail-open, R9) when no active schedule exists for the team", async () => {
    mockGetActiveScheduleForTeam.mockResolvedValue(null);

    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { team_id: { old: null, new: "team-1" } },
    } as unknown as TriggerEvent;

    const redis = redisMock();
    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redis,
    );

    expect(mockUpdateEntity).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      dbMock,
      expect.objectContaining({ action: "oncall.no_schedule" }),
    );
    expect(redis.sadd).toHaveBeenCalledWith(
      "oncall:coverage_gap:t-1",
      "team-1",
    );
  });

  it("audits the same oncall.no_schedule action when the cascade is exhausted (R8b/R9 fail-open parity)", async () => {
    mockGetActiveScheduleForTeam.mockResolvedValue(SCHEDULE);
    mockResolveOncallCascade.mockResolvedValue({ tier: null, userId: null });

    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { team_id: { old: null, new: "team-1" } },
    } as unknown as TriggerEvent;

    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redisMock(),
    );

    expect(mockUpdateEntity).not.toHaveBeenCalled();
    const call = mockWriteAuditEntry.mock.calls.find(
      (c) => c[1].action === "oncall.no_schedule",
    );
    expect(call?.[1].metadata).toMatchObject({ cascadeExhausted: true });
  });

  it("is idempotent — a second delivery for the same (ticket, team) pair is a no-op (R11)", async () => {
    const redis = redisMock(null); // NX claim fails: already processed

    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { team_id: { old: null, new: "team-1" } },
    } as unknown as TriggerEvent;

    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redis,
    );

    expect(mockGetActiveScheduleForTeam).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("no-ops when team_id did not change in this entity.updated event", async () => {
    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { priority: { old: "low", new: "high" } },
    } as unknown as TriggerEvent;

    await executeResolveOncallAction(
      dbMock as never,
      "t-1",
      RULE_ID,
      EXEC_ID,
      event,
      {},
      0,
      redisMock(),
    );

    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockGetActiveScheduleForTeam).not.toHaveBeenCalled();
  });
});
