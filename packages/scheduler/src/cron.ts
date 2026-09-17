/**
 * Cron expression validation + next-fire computation.
 * docs/temporal-scheduler-design.md §3.2, docs/specs/temporal-scheduler.md.
 *
 * cron-parser v5 replaced the v4 `parseExpression` function export with
 * `CronExpressionParser.parse(expr, options)` -- verified against the
 * installed package's own .d.ts files before writing this (source-driven-
 * development), not assumed from older docs/training data.
 */

import { CronExpressionParser } from "cron-parser";
import { toString as cronToHuman } from "cronstrue";

export class InvalidCronExpressionError extends Error {
  constructor(
    public readonly cronExpr: string,
    cause: unknown,
  ) {
    super(
      `Invalid cron expression "${cronExpr}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "InvalidCronExpressionError";
  }
}

/**
 * Validates a cron expression, throwing InvalidCronExpressionError if it
 * cannot be parsed. Callers at the route layer catch this and map it to a
 * 422 with a human-readable message (docs/temporal-scheduler-design.md
 * §2.1's POST /admin/schedule-rules error contract).
 */
export function validateCronExpr(cronExpr: string): void {
  try {
    CronExpressionParser.parse(cronExpr);
  } catch (err) {
    throw new InvalidCronExpressionError(cronExpr, err);
  }
}

/**
 * Computes the next fire time strictly after `from` (default: now), in the
 * given IANA timezone. Throws InvalidCronExpressionError for a malformed
 * cron_expr -- callers must validate with validateCronExpr first if they
 * need a dedicated 422 rather than this function's throw.
 */
export function computeNextFireAt(
  cronExpr: string,
  timezone: string,
  from: Date = new Date(),
): Date {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: from,
      tz: timezone,
    });
    return interval.next().toDate();
  } catch (err) {
    if (err instanceof InvalidCronExpressionError) throw err;
    throw new InvalidCronExpressionError(cronExpr, err);
  }
}

/**
 * Dry-run: the next `count` fire times from now, both as UTC ISO strings
 * and as the rule's local timezone would render them (design doc §2.3's
 * GET /admin/schedule-rules/:id/next-fires).
 */
export function getNextFires(
  cronExpr: string,
  timezone: string,
  count: number,
): { utc: string; local: string }[] {
  const interval = CronExpressionParser.parse(cronExpr, {
    currentDate: new Date(),
    tz: timezone,
  });
  const fires: { utc: string; local: string }[] = [];
  for (let i = 0; i < count; i++) {
    const next = interval.next();
    const date = next.toDate();
    fires.push({
      utc: date.toISOString(),
      // CronDate.toISOString() renders in the parser's configured tz per
      // cron-parser's own semantics; toDate() always gives the UTC instant.
      local: next.toISOString() ?? date.toISOString(),
    });
  }
  return fires;
}

/**
 * Human-readable description of a cron expression (e.g. "At 09:00 on
 * day-of-month 25"), for display alongside the raw cron_expr
 * (design doc §2.1's `cronHuman` field). Returns null for an expression
 * that fails to parse rather than throwing -- callers should already have
 * validated with validateCronExpr before storage, so this is a display-only
 * best-effort helper.
 */
export function describeCronExpr(cronExpr: string): string | null {
  try {
    return cronToHuman(cronExpr, { throwExceptionOnParseError: true });
  } catch {
    return null;
  }
}
