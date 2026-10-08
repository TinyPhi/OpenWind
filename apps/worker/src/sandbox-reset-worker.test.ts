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
const mockTx = { delete: mockDelete };
const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
);

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
  withTenantContext: (...args: Parameters<typeof mockWithTenantContext>) =>
    mockWithTenantContext(...args),
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
  savedViews: { tenantId: "tenantId" },
  labels: { tenantId: "tenantId" },
  ticketLabels: { tenantId: "tenantId" },
  entityInstanceTags: { tenantId: "tenantId" },
  scheduleExecutions: { tenantId: "tenantId" },
}));

vi.mock("drizzle-orm", () => ({ eq: (a: unknown, b: unknown) => [a, b] }));

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

const { processSandboxResetJob } = await import("./sandbox-reset-worker.js");

beforeEach(() => {
  vi.clearAllMocks();
  automationJobs = [];
  slaJobs = [];
  dueDateJobs = [];
  dueDateApproachingJobs = [];
  mockSelectLimit.mockResolvedValue([
    { isSandbox: true, config: { installed_modules: ["helpdesk", "crm"] } },
  ]);
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
    expect(mockSeedAllModulesData).toHaveBeenCalledWith(TENANT_ID, [
      "helpdesk",
      "crm",
    ]);
    expect(mockDeleteTenantFiles).toHaveBeenCalledWith(TENANT_ID);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: "sandbox.reset_completed",
        actorId: "admin-1",
      }),
    );
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

    expect(mockSeedAllModulesData).toHaveBeenCalledWith(TENANT_ID, []);
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
});
