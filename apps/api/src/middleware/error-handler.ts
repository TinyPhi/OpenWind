import { createMiddleware } from "hono/factory";
import { ZodError } from "zod";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { WorkflowError } from "@platform/workflow-engine";
import { EntityError, ValidationError } from "@platform/entity-engine";
import { logger } from "@platform/logger";

const WORKFLOW_STATUS: Record<string, number> = {
  INSTANCE_NOT_FOUND: 404,
  TRANSITION_NOT_AVAILABLE: 409,
  TRANSITION_FORBIDDEN: 403,
  CONDITION_NOT_MET: 422,
  REQUIRED_FIELDS_MISSING: 422,
  SLA_TIMER_FAILED: 500,
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

export const errorHandler = (): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    try {
      await next();
      return;
    } catch (err: unknown) {
      const requestId = c.get("requestId") as string | undefined;

      if (err instanceof ValidationError) {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: err.fields,
          },
          422,
        );
      }

      if (err instanceof WorkflowError) {
        return c.json(
          { error: err.code, message: err.code },
          toStatus(WORKFLOW_STATUS, err.code),
        );
      }

      if (err instanceof EntityError) {
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
        return c.json(
          { error: "HTTP_ERROR", message: err.message },
          err.status,
        );
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
  });
