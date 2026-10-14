import { describe, it, expect, vi, beforeEach } from "vitest";

const executedStatements: string[] = [];

const mockTx = {
  execute: vi.fn(async (query: unknown) => {
    // drizzle sql tagged template objects have queryChunks or asString
    const str =
      typeof query === "object" && query !== null
        ? JSON.stringify(query)
        : String(query);
    executedStatements.push(str);
    return [];
  }),
};

const mockTransaction = vi.fn(async (cb: (tx: unknown) => unknown) => {
  return cb(mockTx);
});

vi.mock("./client.js", () => ({
  db: {
    transaction: (cb: (tx: unknown) => unknown) => mockTransaction(cb),
  },
}));

vi.mock("./schema/index.js", () => ({}));

const {
  withTenantPurgeContext,
  withTenantLifecycleContext,
  withPlatformAdminContext,
  withTenantContext,
  withTenantAndUserContext,
} = await import("./middleware.js");

describe("db middleware context functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executedStatements.length = 0;
  });

  it("withTenantPurgeContext switches role to tenant_purge_role and sets app.tenant_id", async () => {
    const result = await withTenantPurgeContext("tenant-123", async (tx) => {
      expect(tx).toBe(mockTx);
      return "purged";
    });

    expect(result).toBe("purged");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.execute).toHaveBeenCalledTimes(2);
    expect(executedStatements[0]).toContain("tenant_purge_role");
    expect(executedStatements[1]).toContain("tenant-123");
  });

  it("withTenantLifecycleContext switches role to tenant_lifecycle_role inside transaction", async () => {
    const result = await withTenantLifecycleContext(async (tx) => {
      expect(tx).toBe(mockTx);
      return "lifecycle-done";
    });

    expect(result).toBe("lifecycle-done");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.execute).toHaveBeenCalledTimes(1);
    expect(executedStatements[0]).toContain("tenant_lifecycle_role");
  });

  it("withPlatformAdminContext switches role to platform_admin_role inside transaction", async () => {
    const result = await withPlatformAdminContext(async (tx) => {
      expect(tx).toBe(mockTx);
      return "admin-done";
    });

    expect(result).toBe("admin-done");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.execute).toHaveBeenCalledTimes(1);
    expect(executedStatements[0]).toContain("platform_admin_role");
  });

  it("withTenantContext switches role to app_user and sets app.tenant_id", async () => {
    const result = await withTenantContext("tenant-abc", async (tx) => {
      expect(tx).toBe(mockTx);
      return "tenant-done";
    });

    expect(result).toBe("tenant-done");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.execute).toHaveBeenCalledTimes(2);
    expect(executedStatements[0]).toContain("app_user");
    expect(executedStatements[1]).toContain("tenant-abc");
  });

  it("withTenantAndUserContext switches role to app_user and sets both tenant and user ids", async () => {
    const result = await withTenantAndUserContext(
      "tenant-abc",
      "user-xyz",
      async (tx) => {
        expect(tx).toBe(mockTx);
        return "tenant-user-done";
      },
    );

    expect(result).toBe("tenant-user-done");
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.execute).toHaveBeenCalledTimes(2);
    expect(executedStatements[0]).toContain("app_user");
    expect(executedStatements[1]).toContain("tenant-abc");
    expect(executedStatements[1]).toContain("user-xyz");
  });
});
