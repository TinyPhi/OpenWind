import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();

const executedStatements: Array<{ sql: string; params: unknown[] }> = [];

const mockTx = {
  execute: vi.fn(async (query: SQL) => {
    // Compile the Drizzle SQL object to { sql: string, params: unknown[] }
    // using the Postgres dialect compiler rather than inspecting internal AST nodes.
    const compiled = dialect.sqlToQuery(query);
    executedStatements.push(compiled);
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
  setAccessLogRetentionRole,
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

  describe("setAccessLogRetentionRole (migration 0158 / #1131)", () => {
    it("issues SET LOCAL ROLE access_log_retention_role", async () => {
      await setAccessLogRetentionRole(mockTx as never);

      expect(executedStatements).toHaveLength(1);
      expect(executedStatements[0].sql).toContain(
        "SET LOCAL ROLE access_log_retention_role",
      );
    });
  });

  describe("withTenantPurgeContext (migration 0144 / #903)", () => {
    it("switches role to tenant_purge_role and sets app.tenant_id", async () => {
      const result = await withTenantPurgeContext("tenant-123", async (tx) => {
        expect(tx).toBe(mockTx);
        return "purged";
      });

      expect(result).toBe("purged");
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalledTimes(2);
      expect(executedStatements[0].sql).toContain("tenant_purge_role");
      expect(executedStatements[1].sql).toContain("set_config");
      expect(executedStatements[1].params).toEqual(["tenant-123"]);
    });
  });

  describe("pre-existing middleware context helpers (regression coverage)", () => {
    it("withTenantLifecycleContext switches role to tenant_lifecycle_role inside transaction", async () => {
      const result = await withTenantLifecycleContext(async (tx) => {
        expect(tx).toBe(mockTx);
        return "lifecycle-done";
      });

      expect(result).toBe("lifecycle-done");
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalledTimes(1);
      expect(executedStatements[0].sql).toContain("tenant_lifecycle_role");
      expect(executedStatements[0].params).toEqual([]);
    });

    it("withPlatformAdminContext switches role to platform_admin_role inside transaction", async () => {
      const result = await withPlatformAdminContext(async (tx) => {
        expect(tx).toBe(mockTx);
        return "admin-done";
      });

      expect(result).toBe("admin-done");
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalledTimes(1);
      expect(executedStatements[0].sql).toContain("platform_admin_role");
      expect(executedStatements[0].params).toEqual([]);
    });

    it("withTenantContext switches role to app_user and sets app.tenant_id", async () => {
      const result = await withTenantContext("tenant-abc", async (tx) => {
        expect(tx).toBe(mockTx);
        return "tenant-done";
      });

      expect(result).toBe("tenant-done");
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockTx.execute).toHaveBeenCalledTimes(2);
      expect(executedStatements[0].sql).toContain("app_user");
      expect(executedStatements[1].sql).toContain("set_config");
      expect(executedStatements[1].params).toEqual(["tenant-abc"]);
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
      expect(executedStatements[0].sql).toContain("app_user");
      expect(executedStatements[1].sql).toContain("set_config");
      expect(executedStatements[1].params).toEqual(["tenant-abc", "user-xyz"]);
    });
  });
});
