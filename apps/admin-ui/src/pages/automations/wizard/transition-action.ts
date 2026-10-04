// The "transition" action needs a transition id from the workflow the
// triggering record is in (#760). Workflows are 1:1 with record types, so a
// trigger pinned to either one is enough to list them.

export type TransitionOption = {
  id: string;
  fromState: string;
  toState: string;
  label: string | null;
  allowedRoles: string[];
  requiresComment: boolean;
};

export type TransitionsState =
  | { status: "no-workflow" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; transitions: TransitionOption[] };

export type WorkflowSource =
  | { workflowId: string }
  | { entityTypeId: string }
  | null;

export const NO_WORKFLOW_MESSAGE =
  "Choose a workflow or record type on the Trigger step to pick a transition.";

export function workflowSourceFor(
  triggerConfig: Record<string, unknown>,
): WorkflowSource {
  const { workflowId, entityTypeId } = triggerConfig;
  if (typeof workflowId === "string" && workflowId !== "") {
    return { workflowId };
  }
  if (typeof entityTypeId === "string" && entityTypeId !== "") {
    return { entityTypeId };
  }
  return null;
}

export function transitionOptionLabel(t: TransitionOption): string {
  const path = `${t.fromState} → ${t.toState}`;
  return t.label ? `${t.label} (${path})` : path;
}

// Automations run transitions with no actor roles, so the engine rejects any
// role-restricted transition (workflow-engine engine.ts, allowed-roles guard).
export function restrictionReason(t: TransitionOption): string | null {
  if (t.allowedRoles.length === 0) return null;
  return `Restricted to ${t.allowedRoles.join(", ")} — automations can't run it`;
}

// Why this transition action can't be saved yet, or null when it can.
export function transitionActionProblem(
  config: Record<string, unknown>,
  state: TransitionsState,
): string | null {
  if (state.status === "no-workflow") return NO_WORKFLOW_MESSAGE;
  if (state.status === "loading") return "Loading transitions…";
  if (state.status === "error") {
    return "Couldn't load this workflow's transitions.";
  }

  const transitionId = config.transitionId;
  if (typeof transitionId !== "string" || transitionId === "") {
    return "Choose a transition.";
  }
  const selected = state.transitions.find((t) => t.id === transitionId);
  if (!selected) {
    return "This transition isn't in the trigger's workflow any more. Choose another.";
  }
  const restricted = restrictionReason(selected);
  if (restricted) return restricted;
  if (selected.requiresComment) {
    const comment = config.comment;
    if (typeof comment !== "string" || comment.trim() === "") {
      return "This transition needs a comment.";
    }
  }
  return null;
}
