/**
 * org-directory-sync-scheduler.test.ts — docs/specs/org-directory.md T5.
 *
 * @platform/db and @platform/org-directory are mocked at the module boundary
 * (testing-conventions.md — never mock the database itself, but this file
 * only exercises the scheduler's own reconcile logic, not real DB access).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let tenantRows: Array<{ id: string }>;
const mockDbWhere = vi.fn(() => Promise.resolve(tenantRows));
const mockDbFrom = vi.fn(() => ({ where: mockDbWhere }));
const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

vi.mock("@platform/db", () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
  tenants: { id: "id", status: "status" },
}));

const mockGetSyncStatus = vi.fn();
const mockRunOrgDirectorySync = vi.fn();

vi.mock("@platform/org-directory", () => ({
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
  runOrgDirectorySync: (...args: unknown[]) => mockRunOrgDirectorySync(...args),
  ZitadelOrgSourceImporter: class {},
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { reconcile } = await import("./org-directory-sync-scheduler.js");

const NEVER_SYNCED = {
  lastSyncedAt: null,
  lastSyncOk: true,
  staleSinceMs: null,
  syncInProgress: false,
};
const FRESH = {
  lastSyncedAt: new Date().toISOString(),
  lastSyncOk: true,
  staleSinceMs: 60_000,
  syncInProgress: false,
};
const STALE = {
  lastSyncedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  lastSyncOk: true,
  staleSinceMs: 25 * 60 * 60 * 1000,
  syncInProgress: false,
};
const IN_PROGRESS = {
  lastSyncedAt: null,
  lastSyncOk: true,
  staleSinceMs: null,
  syncInProgress: true,
};

describe("org-directory-sync-scheduler reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunOrgDirectorySync.mockResolvedValue({
      status: "completed",
      syncedAt: new Date().toISOString(),
      employeeCount: 0,
      cyclesBroken: 0,
      reparented: 0,
    });
  });

  it("first-boot auto-seeds a tenant that has never synced", async () => {
    tenantRows = [{ id: "tenant-1" }];
    mockGetSyncStatus.mockResolvedValue(NEVER_SYNCED);

    await reconcile();

    expect(mockRunOrgDirectorySync).toHaveBeenCalledWith(
      "tenant-1",
      expect.anything(),
      null,
    );
  });

  it("re-syncs a tenant whose last sync is 24h+ stale", async () => {
    tenantRows = [{ id: "tenant-1" }];
    mockGetSyncStatus.mockResolvedValue(STALE);

    await reconcile();

    expect(mockRunOrgDirectorySync).toHaveBeenCalledTimes(1);
  });

  it("skips a tenant whose last sync is still fresh", async () => {
    tenantRows = [{ id: "tenant-1" }];
    mockGetSyncStatus.mockResolvedValue(FRESH);

    await reconcile();

    expect(mockRunOrgDirectorySync).not.toHaveBeenCalled();
  });

  it("skips a tenant with a sync already in progress -- never fights the admin-triggered route", async () => {
    tenantRows = [{ id: "tenant-1" }];
    mockGetSyncStatus.mockResolvedValue(IN_PROGRESS);

    await reconcile();

    expect(mockRunOrgDirectorySync).not.toHaveBeenCalled();
  });

  it("isolates one tenant's failure from the rest of the reconcile batch", async () => {
    tenantRows = [{ id: "tenant-1" }, { id: "tenant-2" }];
    mockGetSyncStatus.mockImplementation((tenantId: string) =>
      tenantId === "tenant-1"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(NEVER_SYNCED),
    );

    await reconcile();

    expect(mockRunOrgDirectorySync).toHaveBeenCalledWith(
      "tenant-2",
      expect.anything(),
      null,
    );
  });
});
