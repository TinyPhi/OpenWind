/**
 * The four values every workflow record must carry: title, due date, remark and severity
 * (docs/specs/mandatory-ticket-fields.md R4/R5). The assignee is optional: an unassigned
 * ticket stays on its workflow's records list, under the "Unassigned" filter (owner decision
 * 2026-10-19). One check, run by every engine path that creates a record, so a creator that
 * bypasses the API routes (seeders, automations, the scheduler, bulk create) can't skip
 * them; and an update check, so no edit removes a value the record had.
 *
 * While every creator is brought in line the check only logs ("log"); the API and worker set
 * "enforce" from MANDATORY_FIELDS_MODE at startup. The engine reads no config itself, like
 * registerEntityAuditHook.
 */
import { logger } from "@platform/logger";
import { ValidationError } from "./errors.js";
import type { FieldError } from "./errors.js";

export type MandatoryFieldsMode = "log" | "enforce";

let mode: MandatoryFieldsMode = "log";

export function setMandatoryFieldsMode(next: MandatoryFieldsMode): void {
  mode = next;
}

export function getMandatoryFieldsMode(): MandatoryFieldsMode {
  return mode;
}

export interface MandatoryValues {
  title: unknown;
  dueDate: string | Date | null | undefined;
  remark: string | null | undefined;
  severity: string | null | undefined;
}

interface CheckContext {
  tenantId: string;
  entityTypeId: string;
  path: string;
}

function isBlank(v: unknown): boolean {
  return (
    v === undefined || v === null || (typeof v === "string" && v.trim() === "")
  );
}

function required(field: string, label: string): FieldError {
  return { field, code: "required", message: `${label} is required` };
}

/** Pure: which of the four are missing. */
export function findMissingMandatoryFields(
  values: MandatoryValues,
): FieldError[] {
  const errors: FieldError[] = [];
  if (isBlank(values.title)) errors.push(required("title", "Title"));
  if (
    values.dueDate === undefined ||
    values.dueDate === null ||
    values.dueDate === ""
  ) {
    errors.push(required("dueDate", "Due date"));
  }
  if (isBlank(values.remark)) errors.push(required("remark", "Remark"));
  if (isBlank(values.severity)) errors.push(required("severity", "Severity"));
  return errors;
}

function report(
  missing: FieldError[],
  context: CheckContext,
  what: string,
): void {
  if (missing.length === 0) return;
  if (mode === "enforce") throw new ValidationError(missing);
  logger.warn(
    { ...context, missing: missing.map((e) => e.field) },
    `mandatory-fields: workflow record ${what}`,
  );
}

/** Logs or throws (per the mode) when a new workflow record is missing any of the four. */
export function checkMandatoryFields(
  values: MandatoryValues,
  context: CheckContext,
): void {
  report(
    findMissingMandatoryFields(values),
    context,
    "created without mandatory values",
  );
}

/**
 * Logs or throws (per the mode) when an edit removes a value the record had. A value that
 * was already missing (a record from before the rule) doesn't block the edit.
 */
export function checkMandatoryFieldsOnUpdate(
  before: MandatoryValues,
  after: MandatoryValues,
  context: CheckContext,
): void {
  const hadBefore = new Set(
    findMissingMandatoryFields(before).map((e) => e.field),
  );
  report(
    findMissingMandatoryFields(after).filter((e) => !hadBefore.has(e.field)),
    context,
    "edited to remove mandatory values",
  );
}
