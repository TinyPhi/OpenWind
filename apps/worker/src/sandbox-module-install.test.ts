/**
 * sandbox-module-install.test.ts
 *
 * Unit tests for installCoreModulesForSandbox (docs/specs/multi-org-sandbox.md T9).
 * Filesystem and DB are mocked at the boundary -- this is not an isolation test against a
 * real Postgres instance (testing-conventions.md).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExistsSync = vi.fn();
vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: {
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}));

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockExecuteRawInTenantContext = vi.fn().mockResolvedValue(undefined);

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  executeRawInTenantContext: (...args: unknown[]) =>
    mockExecuteRawInTenantContext(...args),
  modules: { id: "id", slug: "slug", name: "name", category: "category" },
  tenants: { id: "id", config: "config" },
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { installCoreModulesForSandbox } =
  await import("./sandbox-module-install.js");

const CORE_MODULES = [
  { id: "mod-helpdesk", slug: "helpdesk", name: "Helpdesk" },
  { id: "mod-crm", slug: "crm", name: "CRM" },
];

beforeEach(() => {
  vi.clearAllMocks();

  // First select() call: core modules list. Second: tenant config read before update.
  mockSelect.mockImplementation(() => ({ from: mockFrom }));
  mockFrom.mockImplementation(() => ({ where: mockWhere }));
  mockWhere.mockImplementation(() => ({
    limit: mockLimit,
    then: (resolve: (v: unknown) => void) => resolve(CORE_MODULES),
  }));
  mockLimit.mockResolvedValue([{ config: {} }]);

  mockUpdate.mockImplementation(() => ({ set: mockSet }));
  mockSet.mockImplementation(() => ({ where: mockUpdateWhere }));

  mockExecuteRawInTenantContext.mockReset().mockResolvedValue(undefined);
  mockExistsSync.mockReturnValue(true);
  mockReaddir.mockResolvedValue(["001_seed.sql"]);
  mockReadFile.mockResolvedValue(
    "INSERT INTO entity_types VALUES ('{TENANT_ID}', '{MODULE_ID}', '{WORKFLOW_NAME}');",
  );
});

describe("installCoreModulesForSandbox", () => {
  it("installs every core module, token-replacing TENANT_ID/MODULE_ID/WORKFLOW_NAME", async () => {
    const result = await installCoreModulesForSandbox("tenant-1");

    expect(result.succeeded.sort()).toEqual(["crm", "helpdesk"]);
    expect(result.failed).toEqual([]);
    expect(mockExecuteRawInTenantContext).toHaveBeenCalledTimes(2);
    expect(mockExecuteRawInTenantContext).toHaveBeenCalledWith(
      "tenant-1",
      expect.stringContaining("'tenant-1'::uuid"),
    );
    expect(mockExecuteRawInTenantContext).toHaveBeenCalledWith(
      "tenant-1",
      expect.stringContaining("'mod-helpdesk'::uuid"),
    );
  });

  it("continues installing remaining modules when one module's seed SQL throws", async () => {
    mockExecuteRawInTenantContext
      .mockRejectedValueOnce(new Error("seed SQL failed"))
      .mockResolvedValueOnce(undefined);

    const result = await installCoreModulesForSandbox("tenant-1");

    expect(result.succeeded).toEqual(["crm"]);
    expect(result.failed).toEqual([
      { slug: "helpdesk", error: "seed SQL failed" },
    ]);
  });

  it("updates the tenant's installed_modules config to only the succeeded slugs", async () => {
    mockExecuteRawInTenantContext
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    await installCoreModulesForSandbox("tenant-1");

    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ installed_modules: ["crm"] }),
      }),
    );
  });

  it("does not update tenant config when no module succeeded", async () => {
    mockExecuteRawInTenantContext.mockRejectedValue(new Error("boom"));

    const result = await installCoreModulesForSandbox("tenant-1");

    expect(result.succeeded).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips a module with no seed directory without failing it", async () => {
    // pnpm-workspace.yaml "exists" everywhere (workspace root resolves immediately);
    // only helpdesk's seed dir is reported missing.
    mockExistsSync.mockImplementation(
      (path: string) => !path.includes("helpdesk"),
    );

    const result = await installCoreModulesForSandbox("tenant-1");

    expect(result.succeeded.sort()).toEqual(["crm", "helpdesk"]);
    expect(result.failed).toEqual([]);
  });
});
