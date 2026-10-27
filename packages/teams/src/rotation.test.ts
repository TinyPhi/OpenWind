import { describe, it, expect } from "vitest";
import {
  nextAssignment,
  planWindows,
  shouldAnnounceWindow,
  ROTATION_MAX_STEPS_PER_RUN,
  ROTATION_NOTICE_LEAD_MS,
} from "./rotation.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T00:00:00Z");

describe("nextAssignment", () => {
  const team = ["a", "b", "c", "d"];

  it("moves primary and backup to the next member in team order", () => {
    expect(nextAssignment(team, { primary: "a", backup: "b" })).toEqual({
      primary: "b",
      backup: "c",
    });
  });

  it("wraps from the last member to the first", () => {
    expect(nextAssignment(team, { primary: "d", backup: "a" })).toEqual({
      primary: "a",
      backup: "b",
    });
  });

  it("takes the member after the new primary when there was no backup", () => {
    expect(nextAssignment(team, { primary: "a", backup: null })).toEqual({
      primary: "b",
      backup: "c",
    });
  });

  it("moves the backup on when it would land on the primary (team of two swaps)", () => {
    expect(nextAssignment(["a", "b"], { primary: "a", backup: "b" })).toEqual({
      primary: "b",
      backup: "a",
    });
    expect(nextAssignment(["a", "b"], { primary: "b", backup: "a" })).toEqual({
      primary: "a",
      backup: "b",
    });
  });

  it("moves the backup on when the previous backup's successor is the new primary", () => {
    // primary a -> b; backup c -> d, but with team [a,b,c] backup c -> a (fine); force a collision
    expect(
      nextAssignment(["a", "b", "c"], { primary: "a", backup: "a" }),
    ).toEqual({ primary: "b", backup: "c" });
  });

  it("gives a one-member team a primary and no backup", () => {
    expect(nextAssignment(["a"], { primary: "a", backup: null })).toEqual({
      primary: "a",
      backup: null,
    });
  });

  it("returns null for a team with no members", () => {
    expect(nextAssignment([], { primary: "a", backup: null })).toBeNull();
  });

  it("hands a departed primary's turn to the head of the list", () => {
    expect(nextAssignment(team, { primary: "gone", backup: "b" })).toEqual({
      primary: "a",
      backup: "c",
    });
  });

  it("hands a departed backup's turn to the head of the list, skipping the primary", () => {
    // primary c -> d; backup "gone" -> head "a"
    expect(nextAssignment(team, { primary: "c", backup: "gone" })).toEqual({
      primary: "d",
      backup: "a",
    });
    // primary d -> a; backup "gone" -> head "a" collides, so b
    expect(nextAssignment(team, { primary: "d", backup: "gone" })).toEqual({
      primary: "a",
      backup: "b",
    });
  });

  it("starts at the head of the list when nothing is known", () => {
    expect(nextAssignment(team, { primary: null, backup: null })).toEqual({
      primary: "a",
      backup: "b",
    });
  });

  it("never returns the same person as primary and backup for a team of two or more", () => {
    for (const members of [["a", "b"], ["a", "b", "c"], team]) {
      let prev = {
        primary: null as string | null,
        backup: null as string | null,
      };
      for (let i = 0; i < 25; i++) {
        const next = nextAssignment(members, prev);
        expect(next?.backup).not.toBe(next?.primary);
        prev = { primary: next?.primary ?? null, backup: next?.backup ?? null };
      }
    }
  });
});

describe("planWindows", () => {
  const base = {
    members: ["a", "b", "c"],
    cycleDays: 7,
    previous: { primary: "a", backup: "b" } as const,
    escalationManager: "c" as string | null,
    endsOn: null,
  };

  it("creates nothing while the next window is more than the notice lead away", () => {
    const now = new Date(T0.getTime() - ROTATION_NOTICE_LEAD_MS - 1000);
    const r = planWindows({ ...base, nextStartsAt: T0, now });
    expect(r.windows).toEqual([]);
    expect(r.cursor.nextStartsAt).toEqual(T0);
  });

  it("creates the next window once the current one is within two days of ending", () => {
    const now = new Date(T0.getTime() - ROTATION_NOTICE_LEAD_MS);
    const r = planWindows({ ...base, nextStartsAt: T0, now });
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0]).toEqual({
      startsAt: T0,
      endsAt: new Date(T0.getTime() + 7 * DAY),
      primary: "b",
      backup: "c",
      escalationManager: "c",
    });
    expect(r.cursor).toEqual({
      nextStartsAt: new Date(T0.getTime() + 7 * DAY),
      lastPrimary: "b",
      lastBackup: "c",
    });
  });

  it("makes windows back to back, each exactly cycleDays long", () => {
    const now = new Date(T0.getTime() + 20 * DAY);
    const r = planWindows({ ...base, cycleDays: 3, nextStartsAt: T0, now });
    for (const [i, w] of r.windows.entries()) {
      expect(w.endsAt.getTime() - w.startsAt.getTime()).toBe(3 * DAY);
      if (i > 0) expect(w.startsAt).toEqual(r.windows[i - 1]?.endsAt);
    }
  });

  it("steps through missed cycles in order but only lists windows that have not ended", () => {
    // 3 cycles of 7 days fully over; the 4th (T0+21d) is current and the 5th (T0+28d) is within the lead
    const now = new Date(T0.getTime() + 26 * DAY);
    const r = planWindows({ ...base, nextStartsAt: T0, now });
    expect(r.skippedEnded).toBe(3);
    expect(r.windows[0]?.startsAt).toEqual(new Date(T0.getTime() + 21 * DAY));
    // the skipped cycles still advanced the rotation: a->b->c->a, so the 4th is primary b? check order
    // previous a/b: step1 b/c, step2 c/a, step3 a/b, step4 b/c
    expect(r.windows[0]).toMatchObject({ primary: "b", backup: "c" });
    // and the next one (T0+28d, within the lead of now) follows
    expect(r.windows[1]?.startsAt).toEqual(new Date(T0.getTime() + 28 * DAY));
    expect(r.windows[1]).toMatchObject({ primary: "c", backup: "a" });
  });

  it("never lists a cycle that is already over", () => {
    const now = new Date(T0.getTime() + 100 * DAY);
    const r = planWindows({ ...base, nextStartsAt: T0, now });
    for (const w of r.windows)
      expect(w.endsAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("stops at the step cap and says so", () => {
    const now = new Date(T0.getTime() + 1000 * DAY);
    const r = planWindows({
      ...base,
      cycleDays: 3,
      nextStartsAt: T0,
      now,
    });
    expect(r.capped).toBe(true);
    expect(r.skippedEnded + r.windows.length).toBe(ROTATION_MAX_STEPS_PER_RUN);
  });

  it("continues from the cursor on the next run after a capped one", () => {
    const now = new Date(T0.getTime() + 400 * DAY);
    const first = planWindows({
      ...base,
      cycleDays: 3,
      nextStartsAt: T0,
      now,
      maxSteps: 10,
    });
    expect(first.capped).toBe(true);
    const second = planWindows({
      ...base,
      cycleDays: 3,
      nextStartsAt: first.cursor.nextStartsAt,
      previous: {
        primary: first.cursor.lastPrimary,
        backup: first.cursor.lastBackup,
      },
      now,
      maxSteps: 10,
    });
    const whole = planWindows({
      ...base,
      cycleDays: 3,
      nextStartsAt: T0,
      now,
      maxSteps: 20,
    });
    expect(second.cursor).toEqual(whole.cursor);
  });

  it("generates nothing past the end date", () => {
    const now = new Date(T0.getTime() + 13 * DAY);
    const r = planWindows({
      ...base,
      nextStartsAt: T0,
      now,
      endsOn: "2026-11-09",
    });
    // 11-02 is already over (stepped past); 11-09 starts on the end date so it is made; 11-16 is not
    expect(r.windows.map((w) => w.startsAt.toISOString().slice(0, 10))).toEqual(
      ["2026-11-09"],
    );
    expect(r.stoppedBy).toBe("ends_on");
  });

  it("generates nothing for a team with no members and keeps the cursor", () => {
    const now = new Date(T0.getTime() + 10 * DAY);
    const r = planWindows({ ...base, members: [], nextStartsAt: T0, now });
    expect(r.windows).toEqual([]);
    expect(r.stoppedBy).toBe("no_members");
    expect(r.cursor.nextStartsAt).toEqual(T0);
  });

  it("leaves the escalation manager empty when they are no longer a member", () => {
    const now = new Date(T0.getTime() - DAY);
    const r = planWindows({
      ...base,
      escalationManager: "left",
      nextStartsAt: T0,
      now,
    });
    expect(r.windows[0]?.escalationManager).toBeNull();
  });

  it("carries an edited previous assignment forward", () => {
    // admin swapped the last window to primary c / backup a: the next one is a / b
    const now = new Date(T0.getTime() - DAY);
    const r = planWindows({
      ...base,
      previous: { primary: "c", backup: "a" },
      nextStartsAt: T0,
      now,
    });
    expect(r.windows[0]).toMatchObject({ primary: "a", backup: "b" });
  });
});

describe("shouldAnnounceWindow", () => {
  it("announces a window that has not started", () => {
    expect(shouldAnnounceWindow(new Date(T0.getTime() + 1), T0)).toBe(true);
  });
  it("never announces a window that has already started", () => {
    expect(shouldAnnounceWindow(T0, T0)).toBe(false);
    expect(shouldAnnounceWindow(new Date(T0.getTime() - 1), T0)).toBe(false);
  });
});
