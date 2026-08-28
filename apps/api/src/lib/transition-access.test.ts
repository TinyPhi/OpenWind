import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockGetWorkflow = vi.fn();
const mockIsWorkflowAdmin = vi.fn();

vi.mock("@platform/workflow-engine", async () => {
  const actual = await vi.importActual<typeof WorkflowEngine>(
    "@platform/workflow-engine",
  );
  return {
    ...actual,
    getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
    isWorkflowAdmin: (...args: unknown[]) => mockIsWorkflowAdmin(...args),
  };
});

const { hasTransitionAccess } = await import("./transition-access.js");
const { WorkflowError } = await import("@platform/workflow-engine");

const INSTANCE = {
  createdBy: "someone-else",
  assignedTo: null,
  workflowId: "workflow-1",
};

describe("hasTransitionAccess", () => {
  beforeEach(() => {
    mockGetWorkflow.mockClear();
    mockIsWorkflowAdmin.mockClear();
  });

  // PR #484 review, PrabhuVijit B-03 — a blank catch previously swallowed
  // every getWorkflow error (not just WORKFLOW_NOT_FOUND) into a silent
  // false/404, turning real DB/infra failures into an indistinguishable,
  // unlogged access denial.
  it("returns false on a WORKFLOW_NOT_FOUND race, without throwing", async () => {
    mockGetWorkflow.mockRejectedValueOnce(
      new WorkflowError("WORKFLOW_NOT_FOUND", { workflowId: "workflow-1" }),
    );

    const result = await hasTransitionAccess(
      {} as never,
      "tenant-1",
      INSTANCE,
      "no-access-person",
    );

    expect(result).toBe(false);
  });

  it("re-throws a non-WORKFLOW_NOT_FOUND WorkflowError instead of silently returning false", async () => {
    mockGetWorkflow.mockRejectedValueOnce(
      new WorkflowError("WORKFLOW_TRANSITION_NOT_FOUND", {
        workflowId: "workflow-1",
      }),
    );

    await expect(
      hasTransitionAccess({} as never, "tenant-1", INSTANCE, "some-person"),
    ).rejects.toThrow(WorkflowError);
  });

  it("re-throws a non-WorkflowError (e.g. a raw DB failure) instead of silently returning false", async () => {
    mockGetWorkflow.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(
      hasTransitionAccess({} as never, "tenant-1", INSTANCE, "some-person"),
    ).rejects.toThrow("connection terminated");
  });

  it("returns true when the workflow lookup succeeds and the caller is a workflow admin", async () => {
    mockGetWorkflow.mockResolvedValueOnce({ id: "workflow-1" });
    mockIsWorkflowAdmin.mockReturnValueOnce(true);

    const result = await hasTransitionAccess(
      {} as never,
      "tenant-1",
      INSTANCE,
      "admin-person",
    );

    expect(result).toBe(true);
  });

  it("returns true without a workflow lookup when the caller is the creator", async () => {
    const result = await hasTransitionAccess(
      {} as never,
      "tenant-1",
      { ...INSTANCE, createdBy: "creator-person" },
      "creator-person",
    );

    expect(result).toBe(true);
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});
