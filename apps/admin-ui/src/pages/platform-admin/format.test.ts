import "../../i18n.js";
import { describe, it, expect } from "vitest";
import {
  dayLabel,
  groupByDay,
  isExpiringSoon,
  relativeTime,
  shortId,
  trialCountdown,
} from "./format.js";
import type { AuditEntry } from "./format.js";

const NOW = new Date("2026-10-12T15:00:00").getTime();

function at(iso: string): AuditEntry {
  return {
    id: iso,
    actorSub: "pa-1",
    action: "sandbox.created",
    targetTenantId: "t",
    createdAt: new Date(iso).toISOString(),
  };
}

describe("relativeTime", () => {
  it.each([
    ["2026-10-12T14:59:30", "just now"],
    ["2026-10-12T14:15:00", "45m ago"],
    ["2026-10-12T10:00:00", "5h ago"],
    ["2026-10-09T15:00:00", "3d ago"],
  ])("%s -> %s", (iso, expected) => {
    expect(relativeTime(new Date(iso).toISOString(), NOW)).toBe(expected);
  });

  it("falls back to a calendar date beyond 30 days", () => {
    const iso = new Date("2026-08-01T12:00:00").toISOString();
    expect(relativeTime(iso, NOW)).toBe(new Date(iso).toLocaleDateString());
  });
});

describe("dayLabel", () => {
  it("names today and yesterday by calendar day, not 24h windows", () => {
    expect(dayLabel(new Date("2026-10-12T00:05:00").toISOString(), NOW)).toBe(
      "Today",
    );
    expect(dayLabel(new Date("2026-10-11T23:55:00").toISOString(), NOW)).toBe(
      "Yesterday",
    );
  });
});

describe("groupByDay", () => {
  it("buckets consecutive entries by day, keeping order", () => {
    const groups = groupByDay(
      [
        at("2026-10-12T14:00:00"),
        at("2026-10-12T09:00:00"),
        at("2026-10-11T18:00:00"),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});

describe("shortId", () => {
  it("keeps the first 8 characters", () => {
    expect(shortId("abcdef12-3456")).toBe("abcdef12");
  });
});

const HOUR = 3_600_000;
const iso = (offsetMs: number): string =>
  new Date(NOW + offsetMs).toISOString();

describe("trialCountdown", () => {
  it.each([
    [null, "No trial"],
    [iso(5 * 24 * HOUR + HOUR), "5 days left"],
    [iso(24 * HOUR + HOUR), "1 day left"],
    [iso(3 * HOUR), "Ends today"],
    [iso(-3 * HOUR), "Expired today"],
    [iso(-2 * 24 * HOUR - HOUR), "Expired 2 days ago"],
  ])("%s -> %s", (endsAt, expected) => {
    expect(trialCountdown(endsAt, NOW)).toBe(expected);
  });
});

describe("isExpiringSoon", () => {
  it("is true only for a trial ending within the next 7 days", () => {
    expect(isExpiringSoon(iso(3 * 24 * HOUR), NOW)).toBe(true);
    expect(isExpiringSoon(iso(8 * 24 * HOUR), NOW)).toBe(false);
    expect(isExpiringSoon(iso(-HOUR), NOW)).toBe(false);
    expect(isExpiringSoon(null, NOW)).toBe(false);
  });
});
