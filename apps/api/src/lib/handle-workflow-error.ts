import type { Context } from "hono";
import { WorkflowError } from "@platform/workflow-engine";
import { logger } from "@platform/logger";

export function handleWorkflowError(c: Context, err: unknown): Response {
  if (err instanceof WorkflowError) {
    switch (err.code) {
      case "WORKFLOW_NOT_FOUND":
      case "WORKFLOW_STATE_NOT_FOUND":
      case "WORKFLOW_TRANSITION_NOT_FOUND":
      case "INSTANCE_NOT_FOUND":
        return c.json({ error: err.code, message: "Not found" }, 404) as Response;

      case "WORKFLOW_HAS_ACTIVE_INSTANCES":
        return c.json(
          {
            error: err.code,
            message: "Cannot delete: workflow has active entity instances",
          },
          409,
        ) as Response;

      case "WORKFLOW_STATE_IN_USE":
        return c.json(
          {
            error: err.code,
            message: "Cannot delete: state is referenced by one or more transitions",
          },
          409,
        ) as Response;

      case "TRANSITION_FORBIDDEN":
        return c.json({ error: err.code, message: "Forbidden" }, 403) as Response;

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
