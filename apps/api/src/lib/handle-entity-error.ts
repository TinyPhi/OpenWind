import type { Context } from "hono";
import type { EntityError, ValidationError } from "@platform/entity-engine";
import { logger } from "@platform/logger";

function isValidationError(err: unknown): err is ValidationError {
  return err instanceof Error && err.name === "ValidationError";
}

function isEntityError(err: unknown): err is EntityError {
  return err instanceof Error && err.name === "EntityError";
}

export function handleEntityError(c: Context, err: unknown): Response {
  if (isValidationError(err)) {
    return c.json(
      {
        error: "VALIDATION_ERROR",
        message: "Validation failed",
        fields: err.fields,
      },
      422,
    ) as Response;
  }

  if (isEntityError(err)) {
    switch (err.code) {
      case "ENTITY_TYPE_NOT_FOUND":
      case "ENTITY_NOT_FOUND":
      case "FIELD_NOT_FOUND":
      case "RELATION_NOT_FOUND":
      case "RELATION_TARGET_NOT_FOUND":
        return c.json(
          { error: err.code, message: "Not found" },
          404,
        ) as Response;
      case "ENTITY_TYPE_HAS_INSTANCES":
        return c.json(
          {
            error: err.code,
            message: "Cannot delete: entity type has existing instances",
          },
          409,
        ) as Response;
      case "ENTITY_HAS_ACTIVE_CHILDREN":
        return c.json(
          {
            error: err.code,
            message:
              "Cannot archive: ticket has active children. Pass ?confirm=true to cascade.",
          },
          409,
        ) as Response;
      case "CHILD_ALREADY_HAS_PARENT":
        return c.json(
          { error: err.code, message: "Ticket already has a parent" },
          409,
        ) as Response;
      case "CHILD_CYCLE_DETECTED":
        return c.json(
          { error: err.code, message: "Re-parenting would create a cycle" },
          422,
        ) as Response;
      case "CHILD_DEPTH_EXCEEDED":
        return c.json(
          {
            error: err.code,
            message: "Re-parenting would exceed the maximum child depth",
          },
          422,
        ) as Response;
      case "CHILDREN_CAP_EXCEEDED":
        return c.json(
          {
            error: err.code,
            message: "Parent has reached the maximum number of children",
          },
          422,
        ) as Response;
      case "CHILDREN_DISABLED":
        return c.json(
          {
            error: err.code,
            message: "Child tickets are disabled for this workflow",
          },
          422,
        ) as Response;
      case "SYSTEM_FIELD_IMMUTABLE":
        return c.json(
          { error: err.code, message: "System fields cannot be deleted" },
          422,
        ) as Response;
      case "CUSTOM_FIELDS_NOT_ALLOWED":
        return c.json(
          {
            error: err.code,
            message: "Custom fields are not allowed on this type",
          },
          422,
        ) as Response;
      default:
        break;
    }
  }

  logger.error({ err }, "Unhandled error in entity route");
  return c.json(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    500,
  ) as Response;
}
