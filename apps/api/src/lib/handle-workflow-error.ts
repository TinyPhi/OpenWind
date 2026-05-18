import type { Context } from "hono";
import { WorkflowError } from "@platform/workflow-engine";
import { logger } from "@platform/logger";

export function handleWorkflowError(c: Context, err: unknown): Response {
  if (err instanceof WorkflowError) {
    switch (err.code) {
      case "INSTANCE_NOT_FOUND":
        return c.json(
          { error: err.code, message: "Not found" },
          404,
        ) as Response;
      case "TRANSITION_NOT_AVAILABLE":
        return c.json(
          {
            error: err.code,
            message: "Transition is not available from the current state",
          },
          409,
        ) as Response;
      case "TRANSITION_FORBIDDEN":
        return c.json(
          {
            error: err.code,
            message: "You do not have permission to execute this transition",
          },
          403,
        ) as Response;
      case "CONDITION_NOT_MET":
        return c.json(
          { error: err.code, message: "Transition condition was not met" },
          422,
        ) as Response;
      case "REQUIRED_FIELDS_MISSING":
        return c.json(
          {
            error: err.code,
            message: "Required fields are missing",
            fields: err.meta?.missing,
          },
          422,
        ) as Response;
      default:
        break;
    }
  }

  logger.error({ err }, "Unhandled error in workflow route");
  return c.json(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    500,
  ) as Response;
}
