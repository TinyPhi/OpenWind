import { describe, it, expect, vi } from "vitest";
import type { DbOrTx } from "@platform/db";
import {
  loadTeamMemberIds,
  loadTeamMemberIdsBatch,
  loadPreviousHolders,
  loadPreviousHoldersBatch,
} from "./rotation-state.js";

interface SelectQueryMock {
  from: vi.Mock;
  where: vi.Mock;
  orderBy: vi.Mock;
  limit: vi.Mock;
}

function createMockDb(rows: unknown[]): {
  tx: DbOrTx;
  query: SelectQueryMock;
} {
  const query: SelectQueryMock = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockImplementation(() => {
      const p = Promise.resolve(rows);
      return Object.assign(p, {
        limit: vi
          .fn()
          .mockImplementation((n: number) => Promise.resolve(rows.slice(0, n))),
      });
    }),
    limit: vi
      .fn()
      .mockImplementation((n: number) => Promise.resolve(rows.slice(0, n))),
  };
  const tx = {
    select: vi.fn().mockReturnValue(query),
  } as unknown as DbOrTx;

  return { tx, query };
}

describe("rotation-state", () => {
  describe("loadTeamMemberIds", () => {
    it("returns member user IDs in position order", async () => {
      const { tx } = createMockDb([
        { userId: "u-1" },
        { userId: "u-2" },
        { userId: "u-3" },
      ]);

      const result = await loadTeamMemberIds(tx, "tenant-1", "team-1");
      expect(result).toEqual(["u-1", "u-2", "u-3"]);
    });
  });

  describe("loadTeamMemberIdsBatch", () => {
    it("returns an empty map when teamIds is empty without querying tx", async () => {
      const { tx } = createMockDb([]);
      const result = await loadTeamMemberIdsBatch(tx, "tenant-1", []);
      expect(result.size).toBe(0);
      expect(tx.select).not.toHaveBeenCalled();
    });

    it("batches member queries across multiple teams and maps empty arrays for teams with no members", async () => {
      const { tx } = createMockDb([
        { teamId: "team-1", userId: "u-1" },
        { teamId: "team-1", userId: "u-2" },
        { teamId: "team-2", userId: "u-3" },
      ]);

      const result = await loadTeamMemberIdsBatch(tx, "tenant-1", [
        "team-1",
        "team-2",
        "team-3",
      ]);

      expect(result.size).toBe(3);
      expect(result.get("team-1")).toEqual(["u-1", "u-2"]);
      expect(result.get("team-2")).toEqual(["u-3"]);
      expect(result.get("team-3")).toEqual([]);
    });
  });

  describe("loadPreviousHolders", () => {
    it("returns latest schedule holders when a non-deleted schedule exists", async () => {
      const { tx } = createMockDb([
        { primary: "u-sched-1", backup: "u-sched-2" },
      ]);

      const result = await loadPreviousHolders(tx, "tenant-1", {
        id: "rot-1",
        lastPrimaryUserId: "u-last-1",
        lastBackupUserId: "u-last-2",
      });

      expect(result).toEqual({ primary: "u-sched-1", backup: "u-sched-2" });
    });

    it("falls back to rotation cursor when no schedule exists", async () => {
      const { tx } = createMockDb([]);

      const result = await loadPreviousHolders(tx, "tenant-1", {
        id: "rot-1",
        lastPrimaryUserId: "u-last-1",
        lastBackupUserId: "u-last-2",
      });

      expect(result).toEqual({ primary: "u-last-1", backup: "u-last-2" });
    });
  });

  describe("loadPreviousHoldersBatch", () => {
    it("returns an empty map when rotations is empty without querying tx", async () => {
      const { tx } = createMockDb([]);
      const result = await loadPreviousHoldersBatch(tx, "tenant-1", []);
      expect(result.size).toBe(0);
      expect(tx.select).not.toHaveBeenCalled();
    });

    it("batches lookups across rotations: uses latest schedule when present and falls back to cursor when absent", async () => {
      // Mock returns schedules ordered by startsAt desc.
      // For rot-1, two schedules exist; the first one encountered must be taken.
      // rot-2 has no schedules in the result set, so it should use its fallback cursor.
      // rot-3 has one schedule.
      const { tx } = createMockDb([
        { rotationId: "rot-1", primary: "u-1-latest", backup: "u-2-latest" },
        { rotationId: "rot-1", primary: "u-1-older", backup: "u-2-older" },
        { rotationId: "rot-3", primary: "u-5-sched", backup: "u-6-sched" },
      ]);

      const rotations = [
        {
          id: "rot-1",
          lastPrimaryUserId: "u-cursor-1",
          lastBackupUserId: "u-cursor-2",
        },
        {
          id: "rot-2",
          lastPrimaryUserId: "u-cursor-3",
          lastBackupUserId: "u-cursor-4",
        },
        { id: "rot-3", lastPrimaryUserId: null, lastBackupUserId: null },
      ];

      const result = await loadPreviousHoldersBatch(tx, "tenant-1", rotations);

      expect(result.size).toBe(3);
      // rot-1 gets the latest schedule
      expect(result.get("rot-1")).toEqual({
        primary: "u-1-latest",
        backup: "u-2-latest",
      });
      // rot-2 falls back to cursor
      expect(result.get("rot-2")).toEqual({
        primary: "u-cursor-3",
        backup: "u-cursor-4",
      });
      // rot-3 gets its schedule
      expect(result.get("rot-3")).toEqual({
        primary: "u-5-sched",
        backup: "u-6-sched",
      });
    });
  });
});
