import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

const mockSelectLimit = vi.fn();
const mockSelectOrderBy = vi.fn().mockReturnValue({ limit: mockSelectLimit });
const mockSelectWhere = vi.fn().mockReturnValue({
  orderBy: mockSelectOrderBy,
  limit: mockSelectLimit,
});
const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

const mockTx = {
  select: mockSelect,
};

vi.mock("./client.js", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

vi.mock("./middleware.js", () => ({
  withPlatformAdminContext: vi.fn(async (cb: (tx: unknown) => unknown) => {
    return cb(mockTx);
  }),
}));

import {
  recordPlatformAdminAction,
  listPlatformAdminAuditLog,
} from "./platform-admin-audit.js";

describe("platform-admin-audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordPlatformAdminAction (#893)", () => {
    it("inserts into platform_admin_audit_log on privileged db without requiring a tx param", async () => {
      await recordPlatformAdminAction({
        actorSub: "sub-123",
        action: "sandbox.created",
        targetTenantId: "tenant-456",
      });

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsertValues).toHaveBeenCalledWith({
        actorSub: "sub-123",
        action: "sandbox.created",
        targetTenantId: "tenant-456",
      });
    });

    it("throws an error when called with a tx running as platform_admin_role", async () => {
      const mockRestrictedTx = {
        execute: vi
          .fn()
          .mockResolvedValue([{ current_user: "platform_admin_role" }]),
        insert: mockInsert,
      };

      await expect(
        recordPlatformAdminAction(
          {
            actorSub: "sub-123",
            action: "sandbox.created",
            targetTenantId: "tenant-456",
          },
          mockRestrictedTx as unknown as Parameters<
            typeof recordPlatformAdminAction
          >[1],
        ),
      ).rejects.toThrow(
        "recordPlatformAdminAction cannot be called within platform_admin_role context (platform_admin_role has SELECT only on platform_admin_audit_log)",
      );

      expect(mockRestrictedTx.execute).toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it("allows a privileged tx (not platform_admin_role) to execute insert", async () => {
      const customInsertValues = vi.fn().mockResolvedValue(undefined);
      const customInsert = vi
        .fn()
        .mockReturnValue({ values: customInsertValues });
      const mockPrivilegedTx = {
        execute: vi.fn().mockResolvedValue([{ current_user: "app_user" }]),
        insert: customInsert,
      };

      await recordPlatformAdminAction(
        {
          actorSub: "sub-123",
          action: "sandbox.trial_changed",
          targetTenantId: "tenant-456",
        },
        mockPrivilegedTx as unknown as Parameters<
          typeof recordPlatformAdminAction
        >[1],
      );

      expect(mockPrivilegedTx.execute).toHaveBeenCalled();
      expect(customInsert).toHaveBeenCalledTimes(1);
      expect(customInsertValues).toHaveBeenCalledWith({
        actorSub: "sub-123",
        action: "sandbox.trial_changed",
        targetTenantId: "tenant-456",
      });
    });
  });

  describe("listPlatformAdminAuditLog (#894)", () => {
    it("orders by (createdAt DESC, id DESC) on first page without before cursor", async () => {
      const now = new Date();
      mockSelectLimit.mockResolvedValueOnce([
        {
          id: "entry-1",
          actorSub: "sub-1",
          action: "sandbox.created",
          targetTenantId: "tenant-1",
          createdAt: now,
        },
      ]);

      const result = await listPlatformAdminAuditLog({ limit: 10 });

      expect(mockSelect).toHaveBeenCalled();
      expect(mockSelectOrderBy).toHaveBeenCalled();
      expect(mockSelectLimit).toHaveBeenCalledWith(10);
      expect(result).toEqual([
        {
          id: "entry-1",
          actorSub: "sub-1",
          action: "sandbox.created",
          targetTenantId: "tenant-1",
          createdAt: now.toISOString(),
        },
      ]);
    });

    it("queries cursor with id and createdAt, returning empty if cursor not found", async () => {
      // First select is cursor query, returns empty
      mockSelectLimit.mockResolvedValueOnce([]);

      const result = await listPlatformAdminAuditLog({
        limit: 10,
        before: "non-existent-id",
      });

      expect(result).toEqual([]);
    });

    it("queries next page with composite tiebreaker cursor when before cursor exists", async () => {
      const now = new Date();
      // Cursor query returns cursor row with id and createdAt
      mockSelectLimit.mockResolvedValueOnce([
        { id: "entry-cursor", createdAt: now },
      ]);
      // Second query returns page rows
      mockSelectLimit.mockResolvedValueOnce([
        {
          id: "entry-2",
          actorSub: "sub-2",
          action: "sandbox.reset",
          targetTenantId: "tenant-2",
          createdAt: now,
        },
      ]);

      const result = await listPlatformAdminAuditLog({
        limit: 5,
        before: "entry-cursor",
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("entry-2");
      expect(result[0].action).toBe("sandbox.reset");
      expect(mockSelectOrderBy).toHaveBeenCalled();
      expect(mockSelectLimit).toHaveBeenCalledWith(5);
    });
  });
});
