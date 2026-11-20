/**
 * rotation-timezone.ts — DST-aware date arithmetic for on-call rotation cycles (#1162).
 *
 * Problem:
 * In fixed millisecond arithmetic (cycleDays * 24 * 60 * 60 * 1000 ms), a rotation
 * that crosses a daylight saving boundary (23 h or 25 h calendar day) shifts by +/- 1 hour,
 * ending at 23:00 or 01:00 instead of midnight wall-clock time.
 *
 * Solution:
 * Add calendar days in the specified IANA timezone, preserving wall-clock time
 * across DST spring-forward (gap) and fall-back (overlap) transitions.
 *
 * Disambiguation semantics (RFC 5545 / Temporal "compatible"):
 * - Spring-forward gap (nonexistent local time): advances past the gap into the first
 *   valid instant after the gap (e.g. 02:30 -> 03:30).
 * - Fall-back overlap (repeated local time): picks the earlier occurrence (pre-transition offset).
 *
 * Thread-safety and caching:
 * - Caches Intl.DateTimeFormat per timezone to minimize formatting overhead.
 * - Entirely independent of the host/process timezone (derives UTC offsets purely via UTC components).
 * - Preserves milliseconds from the input date.
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

function getUtcOffsetMs(date: Date, dtf: Intl.DateTimeFormat): number {
  const parts = dtf.formatToParts(date);
  let y = 0,
    m = 0,
    d = 0,
    h = 0,
    min = 0,
    s = 0;
  for (const p of parts) {
    if (p.type === "year") y = parseInt(p.value, 10);
    else if (p.type === "month") m = parseInt(p.value, 10);
    else if (p.type === "day") d = parseInt(p.value, 10);
    else if (p.type === "hour") h = parseInt(p.value, 10);
    else if (p.type === "minute") min = parseInt(p.value, 10);
    else if (p.type === "second") s = parseInt(p.value, 10);
  }
  const localAsUtc = Date.UTC(
    y,
    m - 1,
    d,
    h,
    min,
    s,
    date.getUTCMilliseconds(),
  );
  return localAsUtc - date.getTime();
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
  if (!timeZone || timeZone === "UTC" || timeZone === "utc") {
    return new Date(startDate.getTime() + days * 86_400_000);
  }

  try {
    const dtf = getDateTimeFormat(timeZone);
    const parts = dtf.formatToParts(startDate);
    let y = 0,
      m = 0,
      d = 0,
      h = 0,
      min = 0,
      s = 0;
    for (const p of parts) {
      if (p.type === "year") y = parseInt(p.value, 10);
      else if (p.type === "month") m = parseInt(p.value, 10);
      else if (p.type === "day") d = parseInt(p.value, 10);
      else if (p.type === "hour") h = parseInt(p.value, 10);
      else if (p.type === "minute") min = parseInt(p.value, 10);
      else if (p.type === "second") s = parseInt(p.value, 10);
    }
    const ms = startDate.getUTCMilliseconds();

    // Target date in local time components
    const targetLocalAsUtc = Date.UTC(y, m - 1, d + days, h, min, s, ms);

    // Compute boundaries of the target day to sample UTC offsets
    const dayStartUtc = Date.UTC(y, m - 1, d + days, 0, 0, 0, 0);
    const dayEndUtc = Date.UTC(y, m - 1, d + days, 23, 59, 59, 999);
    const offsetDayStart = getUtcOffsetMs(new Date(dayStartUtc), dtf);
    const offsetDayEnd = getUtcOffsetMs(new Date(dayEndUtc), dtf);

    // Evaluate candidates with pre- and post-transition offsets
    const cand1 = new Date(targetLocalAsUtc - offsetDayStart);
    const cand2 = new Date(targetLocalAsUtc - offsetDayEnd);

    const off1 = getUtcOffsetMs(cand1, dtf);
    if (targetLocalAsUtc - off1 === cand1.getTime()) {
      return cand1;
    }

    const off2 = getUtcOffsetMs(cand2, dtf);
    if (targetLocalAsUtc - off2 === cand2.getTime()) {
      return cand2;
    }

    // Gap (nonexistent local time): cand1 places the instant with pre-transition offset,
    // which advances past the nonexistent gap into the first valid instant (compatible semantics).
    return cand1;
  } catch (err: unknown) {
    console.warn(
      `[rotation-timezone] Failed to resolve timezone "${timeZone}", falling back to 24h days:`,
      err,
    );
    return new Date(startDate.getTime() + days * 86_400_000);
  }
}
