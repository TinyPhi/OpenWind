import type { Context } from "hono";
import { logger } from "@platform/logger";

// Name-based guard — consistent with error-handler.ts pattern; avoids ESM
// module identity issues when dist and src are loaded by different module loaders.
function isAutomationError(
  err: unknown,
): err is { name: string; code: string; meta?: Record<string, unknown> } {
  return (
    err instanceof Error &&
    err.name === "AutomationError" &&
    typeof (err as unknown as Record<string, unknown>)["code"] === "string"
  );
}

export function handleAutomationError(c: Context, err: unknown): Response {
  if (isAutomationError(err)) {
    switch (err.code) {
      case "RULE_NOT_FOUND":
        return c.json(
          { error: err.code, message: "Not found" },
          404,
        ) as Response;
      case "NOTIFY_LINK_INVALID":
        return c.json(
          { error: err.code, message: "Invalid notify link URL or origin" },
          400,
        ) as Response;
      case "INVALID_EVENT_PAYLOAD":
        return c.json(
          {
            error: err.code,
            message: err.meta?.reason ?? "Invalid event payload config",
          },
          400,
        ) as Response;
      case "RULE_CREATE_FAILED":
        logger.error({ err }, "Automation rule create failed unexpectedly");
        return c.json(
          { error: err.code, message: "Failed to create rule" },
          500,
        ) as Response;
      default:
        break;
    }
  }

  logger.error({ err }, "Unhandled error in automation-rules route");
  return c.json(
    { error: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    500,
  ) as Response;
}
