import type { AuthContext } from "@platform/auth";
import type { WorkflowCaller } from "@platform/workflow-engine";

// Only the global `admin` role bypasses per-workflow created_by/assigned_to
// checks. `agent` has broader nav/menu visibility (per the RBAC convention in
// admin-ui/components/layout.tsx) but is NOT a blanket workflow-admin bypass —
// confirmed by tests/isolation/canvas.isolation.test.ts, which expects an
// `agent` caller who isn't the workflow's creator/assignee to get 403 saving
// its canvas. `agent` and `user` are both subject to per-workflow ownership.
export function toWorkflowCaller(auth: AuthContext): WorkflowCaller {
  return {
    userId: auth.userId,
    isGlobalAdmin: auth.roles.includes("admin"),
  };
}
