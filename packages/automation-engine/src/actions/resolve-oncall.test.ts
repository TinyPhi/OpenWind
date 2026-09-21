import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerEvent } from "../event-schemas.js";

const insertedRows: Array<{ table: unknown; values: unknown }> = [];
let entityRow: { assignedTo: string | null } | undefined = undefined;
// /security-review finding, 2026-09-21 -- resolve-oncall.ts now re-validates
// team_id against a real, same-tenant `teams` row before using it. Default
// true so the many existing scenarios below (which all use a legitimate
// "team-1") don't need to opt in individually.
let teamExists = true;

// /review finding, 2026-09-21 -- workflow-admin fallback (R4, resolve-oncall.ts
// handleCascadeMiss -> resolveWorkflowAdminFallback) calls
// getWorkflowByEntityTypeId, whose query chain ends in
// .where(...).orderBy(...).limit(...) -- one extra step this mock didn't
// have before that fallback existed. Default: no governing workflow found
// (workflowRow stays undefined), matching the pre-fallback fail-open
// behavior these existing scenarios assert on.
let workflowRow: { createdBy: string | null } | undefined = undefined;

const dbMock = {
  select: (columns?: Record<string, unknown>) => ({
    from: () => ({
      where: () => ({
        limit: () =>
          // Differentiate the entity_instances.assignedTo lookup
          // (explicit-assignee-wins) from the new teams-existence check by
          // the shape of the selected columns -- both share this same
          // generic chain mock.
          columns && "assignedTo" in columns
            ? Promise.resolve(entityRow ? [entityRow] : [])
            : Promise.resolve(teamExists ? [{ id: "team-1" }] : []),
        orderBy: () => ({
          limit: () => Promise.resolve(workflowRow ? [workflowRow] : []),
        }),
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
  teams: { id: "id", tenantId: "tenant_id", deletedAt: "deleted_at" },
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
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockCounterAdd = vi.fn();
vi.mock("@platform/telemetry", () => ({
  Queue: class {
    add(...args: unknown[]) {
      return mockQueueAdd(...args);
    }
    close(...args: unknown[]) {
      return mockQueueClose(...args);
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
    teamExists = true;
    workflowRow = undefined;
    mockUpdateEntity.mockClear();
    mockGetActiveScheduleForTeam.mockReset();
    mockResolveOncallCascade.mockReset();
    mockWriteAuditEntry.mockClear();
    mockQueueAdd.mockClear();
    mockQueueClose.mockClear();
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
      cascade_exhausted: "false",
    });
    // Backup notification: backup exists and resolved tier isn't backup.
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]?.table).toBe("notifications_table");
    // Vijit review, PR #597 G1 / PR #600 B1: the BullMQ Queue created for
    // the outbound handoff must be closed, or every execution reaching this
    // path leaks its subscriber/publisher IORedis clients.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
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
    // Vijit review, PR #597 B2: all four outcome paths must emit the same
    // label set (outcome/assigned_tier/cascade_exhausted) or Prometheus
    // creates a distinct time series per unique combination, breaking
    // `sum by (outcome)` aggregation in the PR #605 dashboard.
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      outcome: "skipped_explicit_assignee",
      assigned_tier: "none",
      cascade_exhausted: "false",
    });
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
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      outcome: "no_schedule",
      assigned_tier: "none",
      cascade_exhausted: "false",
    });
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
    expect(mockCounterAdd).toHaveBeenCalledWith(1, {
      outcome: "no_schedule",
      assigned_tier: "none",
      cascade_exhausted: "true",
    });
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

  // /security-review finding, 2026-09-21 -- team_id reaching this action via
  // PATCH /entities/:id's free-form `fields`, or via `fields.team_id` set
  // directly on create, is never pre-validated the way POST /entities' own
  // top-level `teamId` param is. Confirms the action itself now closes that
  // gap rather than letting a bogus string flow into audit metadata / the
  // summary comment.
  it("no-ops (no assignment, no audit, no comment) when team_id doesn't resolve to a real team in this tenant", async () => {
    teamExists = false;

    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      actorId: "u-actor",
      changed: { team_id: { old: null, new: "not-a-real-team" } },
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

    expect(mockGetActiveScheduleForTeam).not.toHaveBeenCalled();
    expect(mockUpdateEntity).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
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

  it("no-ops on a stale entity.updated event with no `changed` field (Vijit review, PR #597 B1)", async () => {
    const event = {
      eventType: "entity.updated",
      instanceId: "inst-1",
      actorId: "u-actor",
      // entityTypeId/changed both absent -- a pre-existing outbox row from
      // before entity.updated was added to the poller's allowlist.
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
