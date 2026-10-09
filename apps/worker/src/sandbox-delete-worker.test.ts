/**
 * Unit tests for processSandboxDeleteJob (docs/specs/multi-org-sandbox.md T15). Zitadel,
 * the DB, the tenant-purge queue, and audit writes are all mocked at the service/package
 * boundary (testing-conventions.md -- never mock the database layer inside a real DB test,
 * but this is a pure unit test of the job's orchestration logic, not an isolation test).
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
const mockUpdateReturning = vi.fn();
const mockUpdateWhere = vi.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
const mockLockRelease = vi.fn().mockResolvedValue(undefined);
const mockAcquireTenantAdvisoryLock = vi
  .fn()
  .mockResolvedValue({ acquired: true, release: mockLockRelease });

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  acquireTenantAdvisoryLock: (...args: unknown[]) =>
    mockAcquireTenantAdvisoryLock(...args),
  tenants: {
    id: "id",
    isSandbox: "isSandbox",
    zitadelOrgId: "zitadelOrgId",
    status: "status",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ["eq", a, b],
  and: (...args: unknown[]) => ["and", ...args],
  inArray: (a: unknown, b: unknown) => ["inArray", a, b],
}));

const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const mockDeleteOrg = vi.fn();
const mockInvalidateTenantStatusCache = vi.fn();
vi.mock("@platform/auth", () => ({
  deleteOrg: (...args: unknown[]) => mockDeleteOrg(...args),
  invalidateTenantStatusCache: (...args: unknown[]) =>
    mockInvalidateTenantStatusCache(...args),
}));

const mockTenantPurgeQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("./queues.js", () => ({
  connection: {},
  tenantPurgeQueue: {
    add: (...args: unknown[]) => mockTenantPurgeQueueAdd(...args),
  },
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
    data: { tenantId, ...extraData },
  };
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

const { processSandboxDeleteJob } = await import("./sandbox-delete-worker.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectLimit.mockResolvedValue([
    { isSandbox: true, zitadelOrgId: "org-1" },
  ]);
  mockAcquireTenantAdvisoryLock.mockResolvedValue({
    acquired: true,
    release: mockLockRelease,
  });
  mockUpdateReturning.mockResolvedValue([{ id: TENANT_ID }]);
  mockDeleteOrg.mockResolvedValue(true);
});

describe("processSandboxDeleteJob", () => {
  it("deletes the Zitadel org, flips tenant status to deleted, enqueues an immediate purge, and writes a completed audit entry", async () => {
    const job = makeJob(TENANT_ID, { requestedBy: "admin-1" });

    await processSandboxDeleteJob(job);

    expect(mockDeleteOrg).toHaveBeenCalledWith("org-1");
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" }),
    );
    expect(mockInvalidateTenantStatusCache).toHaveBeenCalledWith(TENANT_ID);
    expect(mockTenantPurgeQueueAdd).toHaveBeenCalledWith(
      "purge",
      { tenantId: TENANT_ID },
      expect.objectContaining({ delay: 0, jobId: `tenant-purge-${TENANT_ID}` }),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: TENANT_ID,
        action: "sandbox.delete_completed",
        actorId: "admin-1",
        metadata: expect.objectContaining({
          zitadelOrgId: "org-1",
          zitadelOrgDeleted: true,
        }),
      }),
    );
  });

  it("acquires and releases the sandbox-lifecycle lock around the delete work", async () => {
    await processSandboxDeleteJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockAcquireTenantAdvisoryLock).toHaveBeenCalledWith(
      TENANT_ID,
      "sandbox-lifecycle",
    );
    expect(mockLockRelease).toHaveBeenCalled();
  });

  it("skips the Zitadel call when the tenant has no zitadelOrgId, but still deletes/purges", async () => {
    mockSelectLimit.mockResolvedValue([
      { isSandbox: true, zitadelOrgId: null },
    ]);

    await processSandboxDeleteJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockDeleteOrg).not.toHaveBeenCalled();
    expect(mockTenantPurgeQueueAdd).toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "sandbox.delete_completed",
        metadata: expect.objectContaining({
          zitadelOrgId: null,
          zitadelOrgDeleted: null,
        }),
      }),
    );
  });

  it("still deletes/purges and completes when the Zitadel org deletion itself fails", async () => {
    mockDeleteOrg.mockResolvedValue(false);

    await processSandboxDeleteJob(
      makeJob(TENANT_ID, { requestedBy: "admin-1" }),
    );

    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockTenantPurgeQueueAdd).toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "sandbox.delete_completed",
        metadata: expect.objectContaining({ zitadelOrgDeleted: false }),
      }),
    );
  });

  it("throws and writes a failed audit entry when the sandbox-lifecycle lock is already held", async () => {
    mockAcquireTenantAdvisoryLock.mockResolvedValue({
      acquired: false,
      release: vi.fn(),
    });

    await expect(
      processSandboxDeleteJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_DELETE_LOCK_NOT_ACQUIRED");

    expect(mockDeleteOrg).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.delete_failed" }),
    );
  });

  it("throws and writes a failed audit entry when the tenant row is not found", async () => {
    mockSelectLimit.mockResolvedValue([]);

    await expect(
      processSandboxDeleteJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_DELETE_TENANT_NOT_FOUND");

    expect(mockAcquireTenantAdvisoryLock).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.delete_failed" }),
    );
  });

  it("throws and writes a failed audit entry when the tenant is not a sandbox", async () => {
    mockSelectLimit.mockResolvedValue([
      { isSandbox: false, zitadelOrgId: null },
    ]);

    await expect(
      processSandboxDeleteJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_DELETE_NOT_A_SANDBOX");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.delete_failed" }),
    );
  });

  it("throws, releases the lock, and writes a failed audit entry when the status update affects zero rows", async () => {
    mockUpdateReturning.mockResolvedValue([]);

    await expect(
      processSandboxDeleteJob(makeJob(TENANT_ID, { requestedBy: "admin-1" })),
    ).rejects.toThrow("SANDBOX_DELETE_INVALID_TENANT_STATUS");

    expect(mockLockRelease).toHaveBeenCalled();
    expect(mockTenantPurgeQueueAdd).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sandbox.delete_failed" }),
    );
  });
});
