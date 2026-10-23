/**
 * Unit tests for processSandboxResetJob (docs/specs/multi-org-sandbox.md T13). Zitadel is
 * not involved here (reset never touches org/accounts); the DB, queues, module reseeding,
 * file cleanup, and audit writes are all mocked at the service/package boundary
 * (testing-conventions.md -- never mock the database layer inside a real DB test, but this
 * is a pure unit test of the job's orchestration logic, not an isolation test).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const mockSelectLimit = vi.fn();
const mockSelect = vi.fn(() => ({
  from: () => ({ where: () => ({ limit: mockSelectLimit }) }),
}));
const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn(() => ({ where: mockDeleteWhere }));
// The sandbox's people, read from the org chart to assign reseeded records.
let orgEmployeeRows: { userId: string | null }[] = [];
const mockTx = {
  delete: mockDelete,
  select: () => ({
    from: () => ({ where: () => Promise.resolve(orgEmployeeRows) }),
  }),
};
const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
);
// Privileged pre-step (migration 0144): records which tables it deleted from.
const purgeDeletes: unknown[] = [];
const mockWithTenantPurgeContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      delete: (table: unknown) => {
        purgeDeletes.push(table);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
);

const mockWithEventLogMaintenanceContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
);
const mockLockRelease = vi.fn().mockResolvedValue(undefined);
const mockAcquireTenantAdvisoryLock = vi
  .fn()
  .mockResolvedValue({ acquired: true, release: mockLockRelease });
const mockRecordPlatformAdminAction = vi.fn().mockResolvedValue(undefined);

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
  withTenantContext: (...args: Parameters<typeof mockWithTenantContext>) =>
    mockWithTenantContext(...args),
  withTenantPurgeContext: (
    ...args: Parameters<typeof mockWithTenantPurgeContext>
  ) => mockWithTenantPurgeContext(...args),
  orgEmployees: { tenantId: "tenantId", userId: "userId" },
  withEventLogMaintenanceContext: (
    ...args: Parameters<typeof mockWithEventLogMaintenanceContext>
  ) => mockWithEventLogMaintenanceContext(...args),
  acquireTenantAdvisoryLock: (...args: unknown[]) =>
    mockAcquireTenantAdvisoryLock(...args),
  recordPlatformAdminAction: (...args: unknown[]) =>
    mockRecordPlatformAdminAction(...args),
  tenants: { id: "id", isSandbox: "isSandbox", config: "config" },
  entityInstances: { tenantId: "tenantId" },
  entityRelations: { tenantId: "tenantId" },
  workflowEvents: { tenantId: "tenantId" },
  automationExecutions: { tenantId: "tenantId" },
  outboxEvents: { tenantId: "tenantId" },
  deadLetterEvents: { tenantId: "tenantId" },
  connectorDeliveryAttempts: { tenantId: "tenantId" },
  idempotencyKeys: { tenantId: "tenantId" },
  ticketAlerts: { tenantId: "tenantId" },
  accessRequests: { tenantId: "tenantId" },
  attachments: { tenantId: "tenantId" },
  files: { tenantId: "tenantId" },
  notifications: { tenantId: "tenantId" },
  notificationRecipients: { tenantId: "tenantId" },
  savedViews: { table: "savedViews", tenantId: "tenantId" },
  labels: { tenantId: "tenantId" },
  ticketLabels: { tenantId: "tenantId" },
  entityInstanceTags: { tenantId: "tenantId" },
  scheduleExecutions: { table: "scheduleExecutions", tenantId: "tenantId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => [a, b],
  and: (...args: unknown[]) => ["and", ...args],
  isNotNull: (a: unknown) => ["isNotNull", a],
}));

const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const mockDeleteTenantFiles = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/files", () => ({
  deleteTenantFiles: (...args: unknown[]) => mockDeleteTenantFiles(...args),
}));

const mockSeedAllModulesData = vi.fn().mockResolvedValue(undefined);
vi.mock("./sandbox-module-data-seed.js", () => ({
  seedAllModulesData: (...args: unknown[]) => mockSeedAllModulesData(...args),
}));

const { mockLoggerError, mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: mockLoggerError },
}));

function makeJob(tenantId: string, extraData: Record<string, unknown> = {}) {
  return {
    id: `job-${tenantId}`,
    tenantId: tenantId,
    data: { tenantId, ...extraData },
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function makeQueue(name: string, jobs: ReturnType<typeof makeJob>[] = []) {
  return {
    name,
    getJobs: vi.fn().mockResolvedValue(jobs),
  };
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";

let automationJobs: ReturnType<typeof makeJob>[] = [];
let slaJobs: ReturnType<typeof makeJob>[] = [];
let dueDateJobs: ReturnType<typeof makeJob>[] = [];
let dueDateApproachingJobs: ReturnType<typeof makeJob>[] = [];

vi.mock("./queues.js", () => ({
  connection: {},
  get automationQueue() {
    return makeQueue("automation", automationJobs);
  },
  get slaQueue() {
    return makeQueue("sla", slaJobs);
  },
  get dueDateQueue() {
    return makeQueue("due-date", dueDateJobs);
  },
  get dueDateApproachingQueue() {
    return makeQueue("due-date-approaching", dueDateApproachingJobs);
  },
}));

const { processSandboxResetJob, RESET_TENANT_TABLES } =
  await import("./sandbox-reset-worker.js");
const { PURGED_TENANT_TABLES } = await import("./tenant-purge.js");

beforeEach(() => {
  vi.clearAllMocks();
  automationJobs = [];
  slaJobs = [];
  dueDateJobs = [];
  dueDateApproachingJobs = [];
  purgeDeletes.length = 0;
  orgEmployeeRows = [{ userId: "u-admin" }, { userId: "u-2" }];
  mockSelectLimit.mockResolvedValue([
    { isSandbox: true, config: { installed_modules: ["helpdesk", "crm"] } },
  ]);
  mockAcquireTenantAdvisoryLock.mockResolvedValue({
    acquired: true,
    release: mockLockRelease,
  });
});

describe("processSandboxResetJob", () => {
  it("wipes business data, reseeds installed modules, and writes a completed audit entry", async () => {
    const job = makeJob(TENANT_ID, { requestedBy: "admin-1" });

    await processSandboxResetJob(job);

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
    expect(mockDelete).toHaveBeenCalled();
    expect(mockWithEventLogMaintenanceContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
    expect(mockSeedAllModulesData).toHaveBeenCalledWith(
      TENANT_ID,
      ["helpdesk", "crm"],
      ["u-admin", "u-2"],
    );
    expect(mockDeleteTenantFiles).toHaveBeenCalledWith(TENANT_ID);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: "sandbox.reset_completed",
        actorId: "admin-1",
      }),
    );
    expect(mockRecordPlatformAdminAction).toHaveBeenCalledWith({
      actorSub: "admin-1",
      action: "sandbox.reset",
      targetTenantId: TENANT_ID,
    });
  });

  it("does not write a platform-admin audit record when the reset fails", async () => {
    mockWithTenantContext.mockRejectedValueOnce(new Error("db down"));

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("db down");

    expect(mockRecordPlatformAdminAction).not.toHaveBeenCalled();
  });

  it("cancels only this tenant's queued jobs, across all four queues, and leaves other tenants' jobs alone", async () => {
    const ownJob1 = makeJob(TENANT_ID);
    const ownJob2 = makeJob(TENANT_ID);
    const otherJob = makeJob(OTHER_TENANT_ID);
    automationJobs = [ownJob1, otherJob];
    slaJobs = [ownJob2];
    dueDateJobs = [otherJob];
    dueDateApproachingJobs = [];

    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(ownJob1.remove).toHaveBeenCalled();
    expect(ownJob2.remove).toHaveBeenCalled();
    expect(otherJob.remove).not.toHaveBeenCalled();
  });

  it("continues past a job that fails to be removed, cancelling the rest", async () => {
    const failingJob = makeJob(TENANT_ID);
    failingJob.remove.mockRejectedValueOnce(new Error("redis blip"));
    const okJob = makeJob(TENANT_ID);
    automationJobs = [failingJob, okJob];

    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(failingJob.remove).toHaveBeenCalled();
    expect(okJob.remove).toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalled();
    // The job still completes successfully despite one cancellation failure.
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_completed" }),
    );
  });

  it("falls back to an empty module list when tenants.config has no installed_modules", async () => {
    mockSelectLimit.mockResolvedValue([{ isSandbox: true, config: {} }]);

    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockSeedAllModulesData).toHaveBeenCalledWith(
      TENANT_ID,
      [],
      ["u-admin", "u-2"],
    );
  });

  it("deletes schedule_executions and saved_views through the purge role, never plain db", async () => {
    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockWithTenantPurgeContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
    expect(purgeDeletes).toEqual([
      expect.objectContaining({ table: "scheduleExecutions" }),
      expect.objectContaining({ table: "savedViews" }),
    ]);
    // Plain db is only ever read here (the tenant row), never written.
    expect(mockDelete).not.toHaveBeenCalledWith(
      expect.objectContaining({ table: "scheduleExecutions" }),
    );
  });

  it("reseeds unassigned when the sandbox has no people with a user id", async () => {
    orgEmployeeRows = [];

    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockSeedAllModulesData).toHaveBeenCalledWith(
      TENANT_ID,
      ["helpdesk", "crm"],
      [],
    );
  });

  it("throws and writes a failed audit entry when the tenant row is not found", async () => {
    mockSelectLimit.mockResolvedValue([]);

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_RESET_TENANT_NOT_FOUND");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_failed" }),
    );
    expect(mockSeedAllModulesData).not.toHaveBeenCalled();
  });

  it("throws and writes a failed audit entry when the tenant is not a sandbox", async () => {
    mockSelectLimit.mockResolvedValue([{ isSandbox: false, config: {} }]);

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_RESET_NOT_A_SANDBOX");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_failed" }),
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("writes a failed audit entry and rethrows when the wipe transaction itself fails", async () => {
    mockWithTenantContext.mockRejectedValueOnce(new Error("db down"));

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("db down");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "sandbox.reset_failed",
        metadata: expect.objectContaining({ error: "db down" }),
      }),
    );
    expect(mockSeedAllModulesData).not.toHaveBeenCalled();
  });

  it("throws and writes a failed audit entry when the sandbox-lifecycle lock is already held (review finding, PR #832)", async () => {
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: false,
      release: vi.fn(),
    });

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_RESET_LOCK_NOT_ACQUIRED");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_failed" }),
    );
    // Nothing wiped: the only tenant-context call is the failure audit write itself.
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockWithTenantContext).toHaveBeenCalledTimes(1);
  });

  it("acquires the sandbox-lifecycle lock before wiping and releases it after a successful reset", async () => {
    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockAcquireTenantAdvisoryLock).toHaveBeenCalledWith(
      TENANT_ID,
      "sandbox-lifecycle",
    );
    expect(mockLockRelease).toHaveBeenCalled();
  });

  it("still releases the lock when the wipe fails partway through", async () => {
    mockWithTenantContext.mockRejectedValueOnce(new Error("db down"));

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("db down");

    expect(mockLockRelease).toHaveBeenCalled();
  });

  it("RESET_TENANT_TABLES is a strict subset of PURGED_TENANT_TABLES (review finding, PR #832)", () => {
    for (const table of RESET_TENANT_TABLES) {
      expect(PURGED_TENANT_TABLES).toContain(table);
    }
  });

  it("never resets the tenants row, so a sandbox keeps its name and logo (R12)", () => {
    expect(RESET_TENANT_TABLES).not.toContain("tenants");
  });

  it("completes the reset when the platform-admin audit record fails (PR #859 review [C])", async () => {
    mockRecordPlatformAdminAction.mockRejectedValueOnce(new Error("db down"));

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_completed" }),
    );
    expect(mockWriteAuditEntry).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_failed" }),
    );
  });

  it("completes the reset and logs error when deleteTenantFiles fails (T13 gap, #836)", async () => {
    mockDeleteTenantFiles.mockRejectedValueOnce(new Error("s3 down"));

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).resolves.toBeUndefined();

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID }),
      "sandbox reset: file deletion failed (best-effort, continuing)",
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_completed" }),
    );
    expect(mockWriteAuditEntry).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.reset_failed" }),
    );
  });

  // admin_audit_log is RLS-protected and the worker connects as app_user: an audit write on
  // the plain connection is rejected every time, so it must go through withTenantContext.
  it("writes the completed audit entry inside the tenant context", async () => {
    await processSandboxResetJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: "sandbox.reset_completed",
      }),
    );
  });

  it("writes the failed audit entry inside the tenant context", async () => {
    mockWithTenantContext.mockRejectedValueOnce(new Error("db down"));

    await expect(
      processSandboxResetJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("db down");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ action: "sandbox.reset_failed" }),
    );
    expect(mockWithTenantContext).toHaveBeenLastCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
  });
});
