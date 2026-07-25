import type { Context } from "hono";
import type { WorkflowError } from "@platform/workflow-engine";
import { logger } from "@platform/logger";

function isWorkflowError(err: unknown): err is WorkflowError {
  return err instanceof Error && err.name === "WorkflowError";
}

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

  if (isWorkflowError(err)) {
    switch (err.code) {
      case "WORKFLOW_NOT_FOUND":
        // createdBy is only present when the workflow exists but the caller
        // lacks per-workflow access (see getWorkflow) — a deliberate,
        // narrow exception to the "404 hides existence" rule so the UI can
        // point the user at who to ask for access.
        return c.json(
          {
            error: err.code,
            message: "Not found",
            meta:
              err.meta?.["createdBy"] !== undefined
                ? { createdBy: err.meta["createdBy"] }
                : undefined,
          },
          404,
        ) as Response;

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

      case "WORKFLOW_STATE_NAME_TAKEN":
        return c.json(
          {
            error: err.code,
            message:
              "Another step in this workflow already uses that internal name",
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

      case "WORKFLOW_ADMIN_LIST_FORBIDDEN":
        return c.json(
          {
            error: err.code,
            message:
              "Only the workflow's creator or a global admin can manage its admin list",
          },
          403,
        ) as Response;

      case "WORKFLOW_ADMIN_REMOVE_CREATOR_FORBIDDEN":
        return c.json(
          {
            error: err.code,
            message:
              "The workflow's creator cannot be removed from the admin list",
          },
          422,
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
