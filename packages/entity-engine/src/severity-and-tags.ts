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

export interface EntityInstanceTag {
  id: string;
  tenantId: string;
  entityInstanceId: string;
  /** Already normalized (trim + lowercase) — see normalizeTagText. */
  tagText: string;
  createdBy: string;
  createdAt: Date;
}
