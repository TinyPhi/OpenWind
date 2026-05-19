import type { Context } from "hono";
import { WorkflowError } from "@platform/workflow-engine";
import { logger } from "@platform/logger";

function isLockError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e["code"] === "55P03") return true;
  const cause = e["cause"];
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as Record<string, unknown>)["code"] === "55P03"
  );
}

export function handleWorkflowError(c: Context, err: unknown): Response {
  if (isLockError(err)) {
    return c.json(
      {
        error: "TRANSITION_CONFLICT",
        message: "Concurrent transition in progress",
      },
      409,
    ) as Response;
  }

  if (err instanceof WorkflowError) {
    switch (err.code) {
      case "WORKFLOW_NOT_FOUND":
      case "WORKFLOW_STATE_NOT_FOUND":
      case "WORKFLOW_TRANSITION_NOT_FOUND":
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
            message:
              "Cannot delete: state is referenced by one or more transitions",
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
          {
            error: err.code,
            message: "Transition conditions not met",
            meta: err.meta,
          },
          422,
        ) as Response;

      case "REQUIRED_FIELDS_MISSING":
        return c.json(
          {
            error: err.code,
            message: "Required fields are missing",
            fields: Array.isArray(err.meta?.missing)
              ? err.meta.missing
              : undefined,
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
