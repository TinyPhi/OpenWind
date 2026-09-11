import { describe, it, expect } from "vitest";
import {
  validateCronExpr,
  computeNextFireAt,
  getNextFires,
  describeCronExpr,
  InvalidCronExpressionError,
} from "./cron.js";

describe("validateCronExpr", () => {
  it("accepts a valid 5-field cron expression", () => {
    expect(() => validateCronExpr("0 9 25 * *")).not.toThrow();
  });

  it("throws InvalidCronExpressionError for a malformed expression", () => {
    expect(() => validateCronExpr("not a cron")).toThrow(
      InvalidCronExpressionError,
    );
  });

  it("throws for a six-field expression with an out-of-range field", () => {
    expect(() => validateCronExpr("99 99 99 99 99")).toThrow(
      InvalidCronExpressionError,
    );
  });
});

describe("computeNextFireAt", () => {
  it("computes the next fire strictly after the given instant", () => {
    const from = new Date("2026-10-01T00:00:00Z");
    const next = computeNextFireAt("0 9 25 * *", "UTC", from);
    expect(next.toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });

  it("respects the IANA timezone when computing the fire instant", () => {
    const from = new Date("2026-10-01T00:00:00Z");
    // 9am Asia/Kolkata (UTC+5:30) on the 25th = 03:30 UTC.
    const next = computeNextFireAt("0 9 25 * *", "Asia/Kolkata", from);
    expect(next.toISOString()).toBe("2026-10-25T03:30:00.000Z");
  });
});

describe("getNextFires", () => {
  it("returns the requested number of upcoming fires in order", () => {
    const fires = getNextFires("0 9 * * 1", "UTC", 3);
    expect(fires).toHaveLength(3);
    const utcDates = fires.map((f) => new Date(f.utc).getTime());
    expect(utcDates[0]).toBeLessThan(utcDates[1]!);
    expect(utcDates[1]).toBeLessThan(utcDates[2]!);
  });
});

describe("describeCronExpr", () => {
  it("returns a human-readable description for a valid expression", () => {
    const human = describeCronExpr("0 9 25 * *");
    expect(human).toBeTruthy();
    expect(human?.toLowerCase()).toContain("25");
  });

  it("returns null for an invalid expression instead of throwing", () => {
    expect(describeCronExpr("not a cron")).toBeNull();
  });
});
