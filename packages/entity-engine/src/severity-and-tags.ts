import { z } from "zod";

/**
 * docs/specs/ticket-severity-and-tags.md §I. Fixed, global, rank-ordered — never
 * tenant-customizable (§V). Rank is the array position (low=1 ... critical=4);
 * display label/color mapping lives in admin-ui (presentation concern), not here.
 */
export const TICKET_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];

export const TicketSeveritySchema = z.enum(TICKET_SEVERITIES);

export const DEFAULT_TICKET_SEVERITY: TicketSeverity = "medium";

export function severityRank(severity: TicketSeverity): number {
  return TICKET_SEVERITIES.indexOf(severity) + 1;
}

/** Max tag length — docs/specs/ticket-severity-and-tags.md §I. */
export const TAG_TEXT_MAX_LENGTH = 50;

/**
 * Trims + lowercases raw tag input. Callers apply this identically on write
 * (tag creation) and on read (the records-page tag filter) so a filter typed
 * as "Railways " matches a tag stored as "railways" — §R6.
 */
export function normalizeTagText(raw: string): string {
  return raw.trim().toLowerCase();
}

export const TagTextSchema = z
  .string()
  .transform(normalizeTagText)
  .pipe(z.string().min(1).max(TAG_TEXT_MAX_LENGTH));

/**
 * Escapes ILIKE wildcard characters (%, _) and the escape character itself
 * (\) in a user-supplied substring before it's wrapped in %...% for a
 * records-page tag-filter query — otherwise a tag filter containing a
 * literal "%" or "_" would act as a SQL wildcard instead of a literal
 * character. Callers must pass this through Postgres' ILIKE ... ESCAPE '\'
 * clause, not bare ILIKE, for the escaping to take effect.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface EntityInstanceTag {
  id: string;
  tenantId: string;
  entityInstanceId: string;
  /** Already normalized (trim + lowercase) — see normalizeTagText. */
  tagText: string;
  createdBy: string;
  createdAt: Date;
}
