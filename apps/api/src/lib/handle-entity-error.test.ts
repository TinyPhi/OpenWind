import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { EntityError, ValidationError } from "@platform/entity-engine";
import { WorkflowError } from "@platform/workflow-engine";
import { handleEntityError } from "./handle-entity-error.js";

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeApp(thrownError: unknown) {
  const app = new Hono();
  app.get("/test", (c) => {
    try {
      throw thrownError;
    } catch (err) {
      return handleEntityError(c, err);
    }
  });
  return app;
}

describe("handleEntityError", () => {
  it("returns 422 for a ValidationError", async () => {
    const res = await makeApp(
      new ValidationError([{ field: "x", code: "invalid", message: "bad" }]),
    ).request("/test");

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for EntityError ENTITY_NOT_FOUND", async () => {
    const res = await makeApp(new EntityError("ENTITY_NOT_FOUND")).request(
      "/test",
    );

    expect(res.status).toBe(404);
  });

  it("returns 404, not 500, for WorkflowError WORKFLOW_NOT_FOUND (#184)", async () => {
    const res = await makeApp(
      new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId: "wf-1" }),
    ).request("/test");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("WORKFLOW_NOT_FOUND");
  });

  it("falls through other WorkflowError codes to the generic 500", async () => {
    const res = await makeApp(
      new WorkflowError("TRANSITION_FORBIDDEN"),
    ).request("/test");

    expect(res.status).toBe(500);
  });

  it("returns a generic 500 for an unrecognized error", async () => {
    const res = await makeApp(new Error("boom")).request("/test");

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("INTERNAL_ERROR");
  });
});
