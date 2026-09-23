/**
 * IANA timezone validation — docs/temporal-scheduler-design.md §1.1:
 * "Validated against Intl.supportedValuesOf('timeZone') before storage."
 *
 * Not implemented as a Set-membership check against
 * Intl.supportedValuesOf('timeZone') (found via manual QA, PLAT-temporal-
 * scheduler-ui): that list is ICU's CANONICAL zone names only, and varies
 * by ICU/Node build -- one build lists "Asia/Kolkata", another lists only
 * the older "Asia/Calcutta" alias for the same zone, even though
 * Intl.DateTimeFormat happily constructs either. A membership check
 * rejected a perfectly valid, commonly-used identifier with a 422 purely
 * because this runtime's ICU build canonicalizes it differently.
 * Intl.DateTimeFormat's own constructor is the authoritative validator --
 * it throws RangeError for a genuinely invalid zone and accepts any valid
 * IANA name or alias regardless of which one ICU considers canonical.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
