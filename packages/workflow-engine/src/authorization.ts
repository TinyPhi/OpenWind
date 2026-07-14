import type { WorkflowDefinition } from "./types.js";

// Global `admin` role bypasses these checks entirely at the route layer —
// callers must check that first (WorkflowCaller.isGlobalAdmin) and
// short-circuit before reaching here.

export function isWorkflowAdmin(
  userId: string,
  workflow: Pick<WorkflowDefinition, "createdBy" | "assignedTo">,
): boolean {
  return workflow.createdBy === userId || workflow.assignedTo.includes(userId);
}

export function isWorkflowAdminListEditor(
  userId: string,
  workflow: Pick<WorkflowDefinition, "createdBy">,
): boolean {
  return workflow.createdBy === userId;
}
