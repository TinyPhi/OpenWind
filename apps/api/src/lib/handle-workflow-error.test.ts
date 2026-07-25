import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import { WorkflowError } from "@platform/workflow-engine";
import { handleWorkflowError } from "./handle-workflow-error.js";

// Minimal fake Context — handleWorkflowError only ever calls c.json(body, status).
function fakeContext(): Context {
  return {
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  } as unknown as Context;
}

describe("handleWorkflowError", () => {
  // #187 — TRANSITION_LOCKED previously had no case in this file's switch,
  // falling through to a generic 500 with no Retry-After header, unlike the
  // identical condition handled correctly by the global onError handler
  // (apps/api/src/middleware/error-handler.ts).
  it("returns 409 with a Retry-After header for TRANSITION_LOCKED", async () => {
    const err = new WorkflowError("TRANSITION_LOCKED");
    const res = handleWorkflowError(fakeContext(), err);

    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("5");
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("TRANSITION_LOCKED");
  });

  // SLA_TIMER_FAILED is unreachable in current application code (defined in
  // WorkflowErrorCode and mapped in error-handler.ts, but nothing throws it
  // yet) — this locks in consistent behavior for when it becomes reachable.
  it("returns 500 for SLA_TIMER_FAILED", async () => {
    const err = new WorkflowError("SLA_TIMER_FAILED");
    const res = handleWorkflowError(fakeContext(), err);

    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("SLA_TIMER_FAILED");
  });

  // Regression baseline — an existing, already-handled case must be unaffected.
  it("still returns 404 for WORKFLOW_NOT_FOUND", async () => {
    const err = new WorkflowError("WORKFLOW_NOT_FOUND");
    const res = handleWorkflowError(fakeContext(), err);

    expect(res.status).toBe(404);
  });

  // Regression baseline — a WorkflowError code with genuinely no case still
  // falls through to the generic 500, not a crash.
  it("falls through to 500 for an unhandled WorkflowError code", async () => {
    // Cast: intentionally exercising the `default` branch with a code not in
    // the current WorkflowErrorCode union.
    const err = new WorkflowError(
      "SOME_FUTURE_CODE" as unknown as Parameters<typeof WorkflowError>[0],
    );
    const res = handleWorkflowError(fakeContext(), err);

    expect(res.status).toBe(500);
  });

  it("returns 500 for a non-WorkflowError error", () => {
    const res = handleWorkflowError(fakeContext(), new Error("boom"));
    expect(res.status).toBe(500);
  });
});
