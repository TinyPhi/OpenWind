/**
 * The five values every workflow record must carry: title, due date, remark, severity, and
 * an assignee or a team (docs/specs/mandatory-ticket-fields.md R4). One check, run by every
 * engine path that creates a record, so a creator that bypasses the API routes (seeders,
 * automations, the scheduler, bulk create) can no longer skip them.
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
  assignedTo: string | null | undefined;
  teamId: unknown;
}

export interface MandatoryExemptions {
  /**
   * The partner API keeps a ticket whose requested assignee can't be resolved, unassigned,
   * until the ADR-012 amendment gives it a fallback owner (spec R6/T11). Nothing else may
   * set this.
   */
  assignee?: boolean;
}

function isBlank(v: unknown): boolean {
  return (
    v === undefined || v === null || (typeof v === "string" && v.trim() === "")
  );
}

function required(field: string, label: string): FieldError {
  return { field, code: "required", message: `${label} is required` };
}

/** Pure: which of the five are missing. */
export function findMissingMandatoryFields(
  values: MandatoryValues,
  exemptions: MandatoryExemptions = {},
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
  if (
    !exemptions.assignee &&
    isBlank(values.assignedTo) &&
    isBlank(values.teamId)
  ) {
    errors.push({
      field: "assignedTo",
      code: "required",
      message: "An assignee or a team is required",
    });
  }
  return errors;
}

/** Logs or throws (per the mode) when a workflow record is missing any of the five. */
export function checkMandatoryFields(
  values: MandatoryValues,
  context: { tenantId: string; entityTypeId: string; path: string },
  exemptions: MandatoryExemptions = {},
): void {
  if (exemptions.assignee) {
    logger.info(
      { ...context },
      "mandatory-fields: partner ticket kept without a resolvable assignee (ADR-012 exemption)",
    );
  }
  const missing = findMissingMandatoryFields(values, exemptions);
  if (missing.length === 0) return;
  if (mode === "enforce") throw new ValidationError(missing);
  logger.warn(
    { ...context, missing: missing.map((e) => e.field) },
    "mandatory-fields: workflow record created without mandatory values",
  );
}
