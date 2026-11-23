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

import { logger } from "@platform/logger";

const warnedZones = new Set<string>();

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

function getLocalParts(
  date: Date,
  dtf: Intl.DateTimeFormat,
): { y: number; m: number; d: number; h: number; min: number; s: number } {
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
  return { y, m, d, h, min, s };
}

function getUtcOffsetMs(date: Date, dtf: Intl.DateTimeFormat): number {
  const { y, m, d, h, min, s } = getLocalParts(date, dtf);
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
    const { y, m, d, h, min, s } = getLocalParts(startDate, dtf);
    const ms = startDate.getUTCMilliseconds();

    // Target date in local time components represented as naive UTC timestamp
    const targetLocalAsUtc = Date.UTC(y, m - 1, d + days, h, min, s, ms);

    // Multi-pass offset resolution:
    // Sample offsets across potential transition boundaries (startDate, targetLocalAsUtc +/- 1 day).
    const offsets = new Set<number>();
    offsets.add(getUtcOffsetMs(startDate, dtf));
    offsets.add(getUtcOffsetMs(new Date(targetLocalAsUtc), dtf));
    offsets.add(getUtcOffsetMs(new Date(targetLocalAsUtc - 86_400_000), dtf));
    offsets.add(getUtcOffsetMs(new Date(targetLocalAsUtc + 86_400_000), dtf));

    // Sample offsets at candidate instants generated from the initial set
    for (const off of Array.from(offsets)) {
      offsets.add(getUtcOffsetMs(new Date(targetLocalAsUtc - off), dtf));
    }

    const validMatches: Date[] = [];
    const allCandidates: Date[] = [];

    for (const off of offsets) {
      const cand = new Date(targetLocalAsUtc - off);
      allCandidates.push(cand);
      const actualOff = getUtcOffsetMs(cand, dtf);
      if (targetLocalAsUtc - actualOff === cand.getTime()) {
        if (!validMatches.some((m) => m.getTime() === cand.getTime())) {
          validMatches.push(cand);
        }
      }
    }

    if (validMatches.length > 1) {
      // Overlap (fall-back): ambiguous local time occurs twice.
      // RFC 5545 / Temporal "compatible" rule: choose earlier instant (pre-transition).
      validMatches.sort((a, b) => a.getTime() - b.getTime());
      return validMatches[0]!;
    }
    if (validMatches.length === 1) {
      return validMatches[0]!;
    }

    // Gap (spring-forward): target local time is nonexistent (skipped by transition).
    // RFC 5545 / Temporal "compatible" rule: advance past the gap into the first
    // valid instant after the gap (the later candidate instant).
    allCandidates.sort((a, b) => b.getTime() - a.getTime());
    return allCandidates[0]!;
  } catch (err: unknown) {
    if (!warnedZones.has(timeZone)) {
      warnedZones.add(timeZone);
      logger.warn(
        { timeZone, err },
        "rotation-timezone: failed to resolve timezone, falling back to 24h days",
      );
    }
    return new Date(startDate.getTime() + days * 86_400_000);
  }
}
