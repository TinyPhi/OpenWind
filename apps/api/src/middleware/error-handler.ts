import { ZodError } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { WorkflowError } from "@platform/workflow-engine";
import type { EntityError, ValidationError } from "@platform/entity-engine";
import { logger } from "@platform/logger";

// Postgres error code 55P03 = lock_not_available (raised by FOR UPDATE NOWAIT)
function isLockNotAvailableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code =
    (err as { code?: unknown }).code ??
    (err as { cause?: { code?: unknown } }).cause?.code;
  return code === "55P03";
}

// Name-based guards avoid instanceof module-identity issues across ESM boundaries.
// Each class sets this.name explicitly in its constructor.
function isWorkflowError(err: unknown): err is WorkflowError {
  return err instanceof Error && err.name === "WorkflowError";
}

function isEntityError(err: unknown): err is EntityError {
  return err instanceof Error && err.name === "EntityError";
}

function isValidationError(err: unknown): err is ValidationError {
  return err instanceof Error && err.name === "ValidationError";
}

const WORKFLOW_STATUS: Record<string, number> = {
  INSTANCE_NOT_FOUND: 404,
  TRANSITION_NOT_AVAILABLE: 409,
  TRANSITION_FORBIDDEN: 403,
  CONDITION_NOT_MET: 422,
  REQUIRED_FIELDS_MISSING: 422,
  SLA_TIMER_FAILED: 500,
  WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_STATE_NOT_FOUND: 404,
  WORKFLOW_TRANSITION_NOT_FOUND: 404,
  WORKFLOW_HAS_ACTIVE_INSTANCES: 409,
  WORKFLOW_STATE_IN_USE: 409,
};

const ENTITY_STATUS: Record<string, number> = {
  ENTITY_TYPE_NOT_FOUND: 404,
  ENTITY_NOT_FOUND: 404,
  FIELD_VALIDATION_FAILED: 422,
  CUSTOM_FIELDS_NOT_ALLOWED: 403,
  FIELD_NAME_CONFLICT: 409,
  RELATION_TARGET_NOT_FOUND: 422,
  FORMULA_EVALUATION_FAILED: 422,
};

type StatusCode = 403 | 404 | 409 | 422 | 500;

function toStatus(map: Record<string, number>, code: string): StatusCode {
  return (map[code] ?? 500) as StatusCode;
}

/**
 * handleError — Hono onError handler.
 *
 * Register as: app.onError(handleError)
 *
 * Hono v4 routes route-handler errors directly to onError, not through
 * middleware next() chains. Using onError is the correct v4 API.
 */
export function handleError(err: unknown, c: Context): Response {
  const requestId = c.get("requestId") as string | undefined;

  if (isLockNotAvailableError(err)) {
    return c.json(
      {
        error: "TRANSITION_CONFLICT",
        message: "Another transition is in progress for this entity",
      },
      409,
    );
  }

  if (isValidationError(err)) {
    return c.json(
      {
        error: "VALIDATION_ERROR",
        message: "Validation failed",
        fields: err.fields,
      },
      422,
    );
  }

  if (isWorkflowError(err)) {
    return c.json(
      { error: err.code, message: err.code },
      toStatus(WORKFLOW_STATUS, err.code),
    );
  }

  if (isEntityError(err)) {
    return c.json(
      { error: err.code, message: err.code },
      toStatus(ENTITY_STATUS, err.code),
    );
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        fields: err.errors.map((e) => ({
          field: e.path.join("."),
          code: e.code,
          message: e.message,
        })),
      },
      422,
    );
  }

  if (err instanceof HTTPException) {
    return c.json({ error: "HTTP_ERROR", message: err.message }, err.status);
  }

  logger.error(
    {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    "Unhandled error",
  );

  return c.json(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    500,
  );
}
