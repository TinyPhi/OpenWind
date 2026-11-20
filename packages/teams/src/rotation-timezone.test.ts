import { describe, it, expect } from "vitest";
import { addCalendarDays } from "./rotation-timezone.js";

describe("addCalendarDays (#1162)", () => {
  it("defaults to 24-hour days when timezone is omitted or UTC", () => {
    const start = new Date("2026-03-01T00:00:00.000Z");
    const endNull = addCalendarDays(start, 7, null);
    const endUtc = addCalendarDays(start, 7, "UTC");

    expect(endNull.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(endUtc.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(endUtc.toISOString()).toBe("2026-03-08T00:00:00.000Z");
  });

  it("handles European spring forward without 1-hour drift (CET -> CEST)", () => {
    // Berlin switches to CEST (UTC+2) on March 29, 2026 at 02:00 -> 03:00.
    // Start Wednesday March 25, 2026 00:00:00 Berlin (UTC+1 -> 2026-03-24T23:00:00.000Z).
    const start = new Date("2026-03-24T23:00:00.000Z");
    const end = addCalendarDays(start, 7, "Europe/Berlin");

    // Must land on Wednesday April 1, 2026 00:00:00 Berlin (UTC+2 -> 2026-03-31T22:00:00.000Z).
    expect(end.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    // Span is 167 hours (7 days minus 1 hour for spring forward)
    expect(end.getTime() - start.getTime()).toBe(167 * 60 * 60 * 1000);

    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    }).format(end);
    expect(formatted).toBe("00:00:00"); // 00:00:00 midnight
  });

  it("handles European fall back without 1-hour drift (CEST -> CET)", () => {
    // Berlin switches to CET (UTC+1) on October 25, 2026 at 03:00 -> 02:00.
    // Start Wednesday October 21, 2026 00:00:00 Berlin (UTC+2 -> 2026-10-20T22:00:00.000Z).
    const start = new Date("2026-10-20T22:00:00.000Z");
    const end = addCalendarDays(start, 7, "Europe/Berlin");

    // Must land on Wednesday October 28, 2026 00:00:00 Berlin (UTC+1 -> 2026-10-27T23:00:00.000Z).
    expect(end.toISOString()).toBe("2026-10-27T23:00:00.000Z");
    // Span is 169 hours (7 days plus 1 hour for fall back)
    expect(end.getTime() - start.getTime()).toBe(169 * 60 * 60 * 1000);

    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    }).format(end);
    expect(formatted).toBe("00:00:00"); // 00:00:00 midnight
  });

  it("handles US Eastern Daylight Time spring forward (EST -> EDT)", () => {
    // US switches to EDT (UTC-4) on March 8, 2026 at 02:00 -> 03:00.
    // Start March 5, 2026 00:00:00 New York (UTC-5 -> 2026-03-05T05:00:00.000Z).
    const start = new Date("2026-03-05T05:00:00.000Z");
    const end = addCalendarDays(start, 7, "America/New_York");

    // 7 days later: March 12, 2026 00:00:00 New York (UTC-4 -> 2026-03-12T04:00:00.000Z).
    expect(end.toISOString()).toBe("2026-03-12T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(167 * 60 * 60 * 1000);
  });

  it("preserves exact 24-hour multiple in non-DST timezones like Asia/Kolkata", () => {
    const start = new Date("2026-03-24T18:30:00.000Z"); // midnight IST
    const end = addCalendarDays(start, 7, "Asia/Kolkata");

    expect(end.toISOString()).toBe("2026-03-31T18:30:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("gracefully falls back to 24h days on invalid timezone strings", () => {
    const start = new Date("2026-03-01T00:00:00.000Z");
    const end = addCalendarDays(start, 3, "Invalid/Timezone");

    expect(end.getTime() - start.getTime()).toBe(3 * 24 * 60 * 60 * 1000);
  });
});
