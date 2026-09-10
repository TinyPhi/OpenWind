/**
 * Ticket template schema + {{variable}} whitelist substitution —
 * docs/specs/temporal-scheduler.md's "Template variable substitution" table,
 * R3. Closed whitelist substitution (regex replace, no template engine) —
 * SSTI is not reachable because there is no eval/Function/Handlebars-style
 * compilation step; unrecognized tokens are left as literal text.
 */

import { z } from "zod";

// Field names are snake_case to match the JSON contract documented in
// docs/specs/temporal-scheduler.md's §I template shape and
// docs/temporal-scheduler-design.md's §1.3/§2.1 examples verbatim -- this
// JSONB blob is a cross-system (route <-> future Phase 3 worker) contract,
// not a Drizzle-managed column, so it follows the documented API shape
// rather than this repo's usual camelCase-in-TS convention.
export const TemplateSchema = z.object({
  title: z.string().trim().min(1).max(500), // trim before min: "   " must fail validation
  description: z.string().trim().max(10000).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  assignee_id: z.string().min(1).optional(),
  team_id: z.string().uuid().optional(),
  service_id: z.string().uuid().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export type Template = z.infer<typeof TemplateSchema>;

const KNOWN_TOKENS = new Set([
  "date",
  "month",
  "month_short",
  "year",
  "week",
  "rule_name",
]);

const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;

export type TemplateVariables = Record<string, string>;

/** ISO-8601 week number (1-53) of the given UTC-anchored calendar date. */
function isoWeekNumber(year: number, month1to12: number, day: number): number {
  const date = new Date(Date.UTC(year, month1to12 - 1, day));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0 .. Sunday = 6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return (
    1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000))
  );
}

/**
 * Builds the substitution variable map from a fire instant, evaluated in the
 * rule's IANA timezone (docs/specs/temporal-scheduler.md's table: "fire date
 * ISO-8601 in rule's timezone" -- the calendar date is the LOCAL date, which
 * can differ from the UTC date near timezone boundaries).
 */
export function buildTemplateVariables(
  fireAt: Date,
  timezone: string,
  ruleName: string,
): TemplateVariables {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(fireAt);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const year = Number(byType.year);
  const month = Number(byType.month);
  const day = Number(byType.day);

  const monthLong = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "long",
  }).format(fireAt);
  const monthShort = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
  }).format(fireAt);

  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    month: monthLong,
    month_short: monthShort,
    year: String(year),
    week: String(isoWeekNumber(year, month, day)),
    rule_name: ruleName,
  };
}

function substitute(text: string, vars: TemplateVariables): string {
  return text.replace(TOKEN_PATTERN, (match, token: string) => {
    const value = vars[token];
    return KNOWN_TOKENS.has(token) && value !== undefined ? value : match;
  });
}

/**
 * Renders {{variable}} tokens in title/description and any string `fields`
 * values (design doc §2.1's example uses {{date}} inside `fields.due_date`).
 * Non-string field values pass through unchanged.
 */
export function renderTemplate(
  template: Template,
  vars: TemplateVariables,
): Template {
  return {
    ...template,
    title: substitute(template.title, vars),
    description:
      template.description !== undefined
        ? substitute(template.description, vars)
        : undefined,
    fields: template.fields
      ? Object.fromEntries(
          Object.entries(template.fields).map(([k, v]) => [
            k,
            typeof v === "string" ? substitute(v, vars) : v,
          ]),
        )
      : undefined,
  };
}
