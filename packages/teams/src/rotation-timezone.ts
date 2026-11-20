/**
 * rotation-timezone.ts — DST-aware date arithmetic for on-call rotation cycles (#1162).
 *
 * Problem:
 * In fixed millisecond arithmetic (cycleDays * 24 * 60 * 60 * 1000 ms), a 7-day rotation
 * that crosses a daylight saving boundary (23 h or 25 h calendar day) shifts by +/- 1 hour,
 * ending at 23:00 or 01:00 instead of midnight wall-clock time.
 *
 * Solution:
 * Add calendar days in the tenant's specified IANA timezone, preserving wall-clock time
 * across DST spring-forward (167 h week) and fall-back (169 h week) transitions.
 * When timeZone is null, empty, or UTC, falls back to neutral 24 h calendar days.
 */

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(date.toLocaleString("en-US", { timeZone }));
  return tzDate.getTime() - utcDate.getTime();
}

/**
 * Adds calendar days to a date within a specific IANA timezone, ensuring local wall-clock
 * time of day remains invariant across daylight saving transitions.
 */
export function addCalendarDays(
  date: Date | string,
  days: number,
  timeZone?: string | null,
): Date {
  const startDate = typeof date === "string" ? new Date(date) : date;
  if (!timeZone || timeZone === "UTC") {
    return new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);
  }

  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });

    const partsMap = new Map<string, number>();
    for (const p of dtf.formatToParts(startDate)) {
      if (p.type !== "literal") {
        partsMap.set(p.type, parseInt(p.value, 10));
      }
    }

    const year = partsMap.get("year") ?? startDate.getUTCFullYear();
    const month = partsMap.get("month") ?? startDate.getUTCMonth() + 1;
    const day = partsMap.get("day") ?? startDate.getUTCDate();
    const hour = partsMap.get("hour") ?? startDate.getUTCHours();
    const minute = partsMap.get("minute") ?? startDate.getUTCMinutes();
    const second = partsMap.get("second") ?? startDate.getUTCSeconds();

    // Construct local wall-clock target as UTC representation
    const targetUtcGuess = new Date(
      Date.UTC(year, month - 1, day + days, hour, minute, second),
    );

    // Iterative refinement to account for DST offset change
    let offset = getTimeZoneOffsetMs(targetUtcGuess, timeZone);
    let target = new Date(targetUtcGuess.getTime() - offset);
    offset = getTimeZoneOffsetMs(target, timeZone);
    target = new Date(targetUtcGuess.getTime() - offset);

    return target;
  } catch {
    // If timezone is invalid or unsupported by runtime, fall back safely to 24h days
    return new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000);
  }
}
