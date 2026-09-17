import { describe, it, expect } from "vitest";
import {
  classifyOncallUser,
  resolveOncallCascade,
  type OnCallScheduleRow,
} from "./oncall-resolver.js";

// Minimal chainable query-builder fake — returns `rows` for any
// select().from().where()[.limit()] chain. Sufficient for these pure-logic
// tests; real Postgres behavior (RLS, indexes, actual filtering) is covered
// by tests/isolation/resolve-oncall.isolation.test.ts.
function fakeTx(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
  };
  return { select: () => chain } as never;
}

const SCHEDULE: OnCallScheduleRow = {
  id: "sched-1",
  tenantId: "t-1",
  teamId: "team-1",
  label: "Primary rotation",
  startsAt: new Date("2026-01-01"),
  endsAt: new Date("2026-01-08"),
  primaryUserId: "u-primary",
  backupUserId: "u-backup",
  escalationManagerUserId: "u-escalation",
  createdBy: "u-admin",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
} as OnCallScheduleRow;

describe("classifyOncallUser", () => {
  it("returns null for a null userId (no tier populated)", () => {
    expect(classifyOncallUser(null, "Some Name")).toBeNull();
  });

  it("returns a resolved entry when a display name is found", () => {
    expect(classifyOncallUser("u-1", "Jane Doe")).toEqual({
      userId: "u-1",
      displayName: "Jane Doe",
    });
  });

  it("marks a userId with no display name as referenced_user_deleted", () => {
    expect(classifyOncallUser("u-1", undefined)).toEqual({
      userId: "u-1",
      displayName: null,
      reason: "referenced_user_deleted",
    });
  });
});

describe("resolveOncallCascade", () => {
  it("resolves to primary when primary is resolvable", async () => {
    const tx = fakeTx([{ userId: "u-primary" }]);
    const result = await resolveOncallCascade(tx, "t-1", SCHEDULE);
    expect(result).toEqual({ tier: "primary", userId: "u-primary" });
  });

  it("falls back to backup when primary is unresolvable (R8b)", async () => {
    const tx = fakeTx([{ userId: "u-backup" }]);
    const result = await resolveOncallCascade(tx, "t-1", SCHEDULE);
    expect(result).toEqual({ tier: "backup", userId: "u-backup" });
  });

  it("falls back to escalation when primary and backup are unresolvable", async () => {
    const tx = fakeTx([{ userId: "u-escalation" }]);
    const result = await resolveOncallCascade(tx, "t-1", SCHEDULE);
    expect(result).toEqual({ tier: "escalation", userId: "u-escalation" });
  });

  it("returns {tier: null} when every populated tier is unresolvable (exhausted cascade)", async () => {
    const tx = fakeTx([]);
    const result = await resolveOncallCascade(tx, "t-1", SCHEDULE);
    expect(result).toEqual({ tier: null, userId: null });
  });

  it("returns {tier: null} when backup/escalation are absent and primary is unresolvable", async () => {
    const tx = fakeTx([]);
    const scheduleWithOnlyPrimary = {
      ...SCHEDULE,
      backupUserId: null,
      escalationManagerUserId: null,
    } as OnCallScheduleRow;
    const result = await resolveOncallCascade(
      tx,
      "t-1",
      scheduleWithOnlyPrimary,
    );
    expect(result).toEqual({ tier: null, userId: null });
  });
});
