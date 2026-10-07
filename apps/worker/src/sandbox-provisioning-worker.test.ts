/**
 * sandbox-provisioning-worker.test.ts
 *
 * Unit tests for processSandboxProvisioningJob (docs/specs/multi-org-sandbox.md T7).
 * Zitadel calls, the DB, org-directory sync, and audit writes are all mocked at the
 * service/package boundary (testing-conventions.md -- never mock the database layer
 * itself inside a real DB test, but this is a pure unit test of the job's orchestration
 * logic, not an isolation test against a real Postgres instance).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockInsert = vi.fn(() => ({ values: mockValues }));
vi.mock("@platform/db", () => ({
  db: { insert: (...args: unknown[]) => mockInsert(...args) },
  tenants: {},
}));

const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const mockCreateOrg = vi.fn();
const mockCreateHumanUser = vi.fn();
const mockGenerateSandboxOrgTemplate = vi.fn();
vi.mock("@platform/auth", () => ({
  createOrg: (...args: unknown[]) => mockCreateOrg(...args),
  createHumanUser: (...args: unknown[]) => mockCreateHumanUser(...args),
  generateSandboxOrgTemplate: () => mockGenerateSandboxOrgTemplate(),
  nextEmailCandidate: (
    template: { emailLocalPart: string },
    domain: string,
    attempt: number,
  ) =>
    attempt === 0
      ? `${template.emailLocalPart}@${domain}`
      : `${template.emailLocalPart}${attempt}@${domain}`,
}));

const mockRunOrgDirectorySync = vi.fn();
vi.mock("@platform/org-directory", () => ({
  runOrgDirectorySync: (...args: unknown[]) => mockRunOrgDirectorySync(...args),
  ZitadelOrgSourceImporter: vi.fn(),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/config", () => ({
  env: { ZITADEL_ISSUER: "http://localhost:8080" },
}));

vi.mock("./queues.js", () => ({ connection: {} }));

const { processSandboxProvisioningJob } =
  await import("./sandbox-provisioning-worker.js");

function makeTemplate(memberCount: number) {
  return {
    admin: {
      givenName: "Olivia",
      familyName: "Smith",
      emailLocalPart: "olivia.smith",
      role: "admin" as const,
    },
    members: Array.from({ length: memberCount }, (_, i) => ({
      givenName: `Member${i}`,
      familyName: "Doe",
      emailLocalPart: `member${i}.doe`,
      role: "member" as const,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReturning.mockResolvedValue([{ id: "tenant-1" }]);
  mockCreateOrg.mockResolvedValue({ ok: true, orgId: "org-1" });
  mockRunOrgDirectorySync.mockResolvedValue({
    status: "ok",
    syncedAt: new Date(),
    employeeCount: 1,
    cyclesBroken: 0,
    reparented: 0,
  });
});

describe("processSandboxProvisioningJob", () => {
  it("creates the org, the tenant row, every seeded account, and runs the directory sync", async () => {
    mockGenerateSandboxOrgTemplate.mockReturnValue(makeTemplate(2));
    mockCreateHumanUser.mockResolvedValue({ ok: true, userId: "user-x" });

    const result = await processSandboxProvisioningJob({
      id: "job-1",
      data: { orgName: "Acme Sandbox", trialDays: 14, requestedBy: "admin-1" },
    });

    expect(mockCreateOrg).toHaveBeenCalledWith("Acme Sandbox");
    expect(mockInsert).toHaveBeenCalled();
    expect(mockCreateHumanUser).toHaveBeenCalledTimes(3); // 1 admin + 2 members
    expect(result.zitadelOrgId).toBe("org-1");
    expect(result.seededAccountCount).toBe(3);
    expect(result.failedAccountCount).toBe(0);
    expect(typeof result.tenantId).toBe("string");
    expect(result.tenantId.length).toBeGreaterThan(0);
    expect(mockRunOrgDirectorySync).toHaveBeenCalledWith(
      result.tenantId,
      expect.anything(),
      "admin-1",
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: result.tenantId,
        action: "sandbox.provisioning_completed",
      }),
    );
  });

  it("retries a seeded account's email on a Zitadel uniqueness conflict", async () => {
    mockGenerateSandboxOrgTemplate.mockReturnValue(makeTemplate(0));
    mockCreateHumanUser
      .mockResolvedValueOnce({ ok: false, conflict: true }) // admin, attempt 0
      .mockResolvedValueOnce({ ok: true, userId: "admin-user" }); // admin, attempt 1

    const result = await processSandboxProvisioningJob({
      id: "job-2",
      data: { orgName: "Acme Sandbox", trialDays: 14, requestedBy: "admin-1" },
    });

    expect(mockCreateHumanUser).toHaveBeenCalledTimes(2);
    expect(mockCreateHumanUser).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ email: "olivia.smith@localhost" }),
    );
    expect(mockCreateHumanUser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ email: "olivia.smith1@localhost" }),
    );
    expect(result.adminEmail).toBe("olivia.smith1@localhost");
  });

  it("continues provisioning other members when one member account fails after retries, and reports the failure count", async () => {
    mockGenerateSandboxOrgTemplate.mockReturnValue(makeTemplate(2));
    mockCreateHumanUser
      .mockResolvedValueOnce({ ok: true, userId: "admin-user" }) // admin
      .mockResolvedValue({ ok: false, conflict: true }); // every member attempt fails

    const result = await processSandboxProvisioningJob({
      id: "job-3",
      data: { orgName: "Acme Sandbox", trialDays: 14, requestedBy: "admin-1" },
    });

    expect(result.seededAccountCount).toBe(1); // admin only
    expect(result.failedAccountCount).toBe(2);
    expect(mockRunOrgDirectorySync).toHaveBeenCalled();
  });

  it("throws and audits sandbox.provisioning_failed when the admin account can never be created", async () => {
    mockGenerateSandboxOrgTemplate.mockReturnValue(makeTemplate(0));
    mockCreateHumanUser.mockResolvedValue({ ok: false, conflict: true });

    await expect(
      processSandboxProvisioningJob({
        id: "job-4",
        data: {
          orgName: "Acme Sandbox",
          trialDays: 14,
          requestedBy: "admin-1",
        },
      }),
    ).rejects.toThrow("SANDBOX_ADMIN_ACCOUNT_CREATE_FAILED");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: expect.any(String),
        action: "sandbox.provisioning_failed",
      }),
    );
    expect(mockRunOrgDirectorySync).not.toHaveBeenCalled();
  });

  it("throws when the Zitadel org can never be created (every name candidate conflicts), and still writes a failure audit entry (security review fix)", async () => {
    mockCreateOrg.mockResolvedValue({ ok: false, conflict: true });

    await expect(
      processSandboxProvisioningJob({
        id: "job-5",
        data: {
          orgName: "Acme Sandbox",
          trialDays: 14,
          requestedBy: "admin-1",
        },
      }),
    ).rejects.toThrow("SANDBOX_ORG_CREATE_FAILED");

    expect(mockInsert).not.toHaveBeenCalled();
    // Previously this path threw before any tenantId existed and before the try block
    // began, so a failure here left zero audit trace -- fixed by generating tenantId
    // upfront and wrapping org creation in the same try/catch as everything else.
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: expect.any(String),
        action: "sandbox.provisioning_failed",
        metadata: expect.objectContaining({ zitadelOrgId: null }),
      }),
    );
  });

  it("writes a failure audit entry when the tenant insert itself throws (e.g. a slug collision)", async () => {
    mockGenerateSandboxOrgTemplate.mockReturnValue(makeTemplate(0));
    mockReturning.mockRejectedValueOnce(new Error("duplicate key value"));

    await expect(
      processSandboxProvisioningJob({
        id: "job-6",
        data: {
          orgName: "Acme Sandbox",
          trialDays: 14,
          requestedBy: "admin-1",
        },
      }),
    ).rejects.toThrow("duplicate key value");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "sandbox.provisioning_failed",
        metadata: expect.objectContaining({ zitadelOrgId: "org-1" }),
      }),
    );
    expect(mockCreateHumanUser).not.toHaveBeenCalled();
  });
});
