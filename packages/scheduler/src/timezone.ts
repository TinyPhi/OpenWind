/**
 * IANA timezone validation — docs/temporal-scheduler-design.md §1.1:
 * "Validated against Intl.supportedValuesOf('timeZone') before storage."
 */

const SUPPORTED_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

export function isValidTimezone(timezone: string): boolean {
  // "UTC" is schedule_rules.timezone's own DB DEFAULT (migration 0101), but
  // Intl.supportedValuesOf('timeZone') does NOT include the bare "UTC"
  // identifier on every Node/ICU build (verified against this repo's actual
  // runtime, not assumed) -- only zone names like "Etc/UTC". Special-casing
  // it here means the column's own default always validates, instead of
  // depending on ICU data version.
  if (timezone === "UTC") return true;
  return SUPPORTED_TIMEZONES.has(timezone);
}
