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

  it("resolves spring-forward gap (compatible disambiguation: advances past gap)", () => {
    // New York springs forward on March 8, 2026: 02:00 -> 03:00.
    // Start at 02:30 EST on March 1, 2026 (07:30 UTC).
    // Target 7 days later: March 8, 2026 02:30 local does NOT exist.
    // Under compatible disambiguation, advances past gap to 03:30 EDT (07:30 UTC).
    const start = new Date("2026-03-01T07:30:00.000Z");
    const end = addCalendarDays(start, 7, "America/New_York");

    expect(end.toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 07:30 UTC is 03:30 EDT
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(end);
    expect(formatted).toBe("03:30");
  });

  it("resolves European spring-forward gap in Berlin (02:00 -> 03:00)", () => {
    // Berlin springs forward on March 29, 2026: 02:00 -> 03:00.
    // Start at 02:30 CET on March 22, 2026 (01:30 UTC).
    // Target 7 days later: March 29, 2026 02:30 does NOT exist.
    // Compatible disambiguation advances to 03:30 CEST (01:30 UTC).
    const start = new Date("2026-03-22T01:30:00.000Z");
    const end = addCalendarDays(start, 7, "Europe/Berlin");

    expect(end.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(end);
    expect(formatted).toBe("03:30");
  });

  it("resolves fall-back overlap by picking earlier occurrence (pre-transition offset)", () => {
    // New York falls back on November 1, 2026: 02:00 -> 01:00.
    // Start October 25, 2026 at 01:30 EDT (05:30 UTC).
    // Target 7 days later: November 1, 2026 01:30 occurs twice (01:30 EDT and 01:30 EST).
    // Compatible disambiguation picks first occurrence: 01:30 EDT (05:30 UTC).
    const start = new Date("2026-10-25T05:30:00.000Z");
    const end = addCalendarDays(start, 7, "America/New_York");

    expect(end.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(end);
    expect(formatted).toBe("01:30");
  });

  it("handles southern-hemisphere transitions (Australia/Sydney spring forward and fall back)", () => {
    // Sydney spring forward: first Sunday in October (October 4, 2026 at 02:00 -> 03:00, AEST to AEDT, UTC+10 -> UTC+11).
    // Start October 1, 2026 00:00 AEST (2026-09-30T14:00:00.000Z).
    const start = new Date("2026-09-30T14:00:00.000Z");
    const end = addCalendarDays(start, 7, "Australia/Sydney");

    // Land on October 8, 2026 00:00 AEDT (2026-10-07T13:00:00.000Z).
    expect(end.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(167 * 60 * 60 * 1000);
  });

  it("handles 30-minute DST shifts in Australia/Lord_Howe", () => {
    // Lord Howe transitions by 30 minutes (UTC+10:30 to UTC+11:00 on October 4, 2026 at 02:00 -> 02:30).
    // Start October 1, 2026 00:00 (2026-09-30T13:30:00.000Z).
    const start = new Date("2026-09-30T13:30:00.000Z");
    const end = addCalendarDays(start, 7, "Australia/Lord_Howe");

    // Land on October 8, 2026 00:00 (2026-10-07T13:00:00.000Z).
    expect(end.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    // Span is 167.5 hours (7 * 24 - 0.5 h)
    expect(end.getTime() - start.getTime()).toBe(167.5 * 60 * 60 * 1000);
  });

  it("handles 45-minute offset zones (Asia/Kathmandu and Australia/Eucla)", () => {
    const startKathmandu = new Date("2026-01-01T00:00:00.123Z");
    const endKathmandu = addCalendarDays(startKathmandu, 7, "Asia/Kathmandu");
    expect(endKathmandu.toISOString()).toBe("2026-01-08T00:00:00.123Z");
    expect(endKathmandu.getUTCMilliseconds()).toBe(123);

    const startEucla = new Date("2026-06-01T00:00:00.456Z");
    const endEucla = addCalendarDays(startEucla, 7, "Australia/Eucla");
    expect(endEucla.toISOString()).toBe("2026-06-08T00:00:00.456Z");
    expect(endEucla.getUTCMilliseconds()).toBe(456);
  });

  it("handles midnight transition in America/Havana", () => {
    // Cuba transitions DST at midnight (00:00 -> 01:00).
    // Start March 5, 2026 00:00 Havana (UTC-5 -> 2026-03-05T05:00:00.000Z).
    // Transition happens Sunday March 8, 2026 at midnight.
    const start = new Date("2026-03-05T05:00:00.000Z");
    const end = addCalendarDays(start, 7, "America/Havana");

    // 7 days later: March 12, 2026 00:00 Havana (UTC-4 -> 2026-03-12T04:00:00.000Z).
    expect(end.toISOString()).toBe("2026-03-12T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(167 * 60 * 60 * 1000);
  });

  it("preserves exact millisecond timestamp offsets", () => {
    const start = new Date("2026-03-01T12:00:00.789Z");
    const end = addCalendarDays(start, 1, "UTC");
    expect(end.toISOString()).toBe("2026-03-02T12:00:00.789Z");
    expect(end.getUTCMilliseconds()).toBe(789);
  });

  it("handles 1-day and 3-day cycles starting on transition day itself", () => {
    // Day of spring forward: March 8, 2026 in New York (23-hour calendar day)
    const transitionDayStart = new Date("2026-03-08T05:00:00.000Z"); // 00:00 EST
    const nextDay = addCalendarDays(transitionDayStart, 1, "America/New_York");
    // Next day at 00:00 EDT is 2026-03-09T04:00:00.000Z (23 hours later)
    expect(nextDay.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(nextDay.getTime() - transitionDayStart.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );

    const threeDays = addCalendarDays(
      transitionDayStart,
      3,
      "America/New_York",
    );
    expect(threeDays.toISOString()).toBe("2026-03-11T04:00:00.000Z");
    expect(threeDays.getTime() - transitionDayStart.getTime()).toBe(
      71 * 60 * 60 * 1000,
    );
  });
});
