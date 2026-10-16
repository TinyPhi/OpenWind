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

  it("returns 422 with the unknown step names for WORKFLOW_CONDITION_STATE_UNKNOWN", async () => {
    const err = new WorkflowError("WORKFLOW_CONDITION_STATE_UNKNOWN", {
      unknown: ["aproval"],
    });
    const res = handleWorkflowError(fakeContext(), err);

    expect(res.status).toBe(422);
    const json = (await res.json()) as {
      error: string;
      meta: { unknown: string[] };
    };
    expect(json.error).toBe("WORKFLOW_CONDITION_STATE_UNKNOWN");
    expect(json.meta.unknown).toEqual(["aproval"]);
  });

  it.each([
    ["OVERRIDE_NOT_ENABLED", 409],
    ["OVERRIDE_FORBIDDEN", 403],
    ["OVERRIDE_REASON_REQUIRED", 422],
    ["OVERRIDE_NO_CHANGE", 409],
  ] as const)("maps the state-override code %s to %i", async (code, status) => {
    const res = handleWorkflowError(fakeContext(), new WorkflowError(code));
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(code);
  });

  it("OVERRIDE_REASON_REQUIRED tells the client the real length bounds", async () => {
    const res = handleWorkflowError(
      fakeContext(),
      new WorkflowError("OVERRIDE_REASON_REQUIRED", { min: 10, max: 1000 }),
    );
    expect(((await res.json()) as { meta: unknown }).meta).toEqual({
      min: 10,
      max: 1000,
    });
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
