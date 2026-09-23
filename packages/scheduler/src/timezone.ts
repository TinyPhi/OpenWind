/**
 * IANA timezone validation — docs/temporal-scheduler-design.md §1.1:
 * "Validated against Intl.supportedValuesOf('timeZone') before storage."
 *
 * Resolution-based, not membership-based: `Intl.supportedValuesOf('timeZone')`
 * enumerates each tzdata zone under exactly one canonical spelling, and
 * which spelling ICU treats as canonical varies by build/version -- on at
 * least one production runtime this repo hit, the list contains the legacy
 * alias "Asia/Calcutta" but NOT the modern, far more commonly typed
 * "Asia/Kolkata", even though both name the identical zone and both are
 * valid IANA identifiers (2026-09-22 incident: a real user's "Asia/Kolkata"
 * schedule rule was rejected as "Invalid IANA timezone"). Constructing an
 * `Intl.DateTimeFormat` with the given zone resolves aliases the same way
 * `computeNextFireAt`'s cron-parser call does (it passes the zone straight
 * through to the tz database), so this check accepts exactly what the
 * scheduler will actually be able to use, regardless of which name ICU's
 * enumeration happens to prefer.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
