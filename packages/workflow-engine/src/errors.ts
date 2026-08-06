export type WorkflowErrorCode =
  | "INSTANCE_NOT_FOUND"
  | "TRANSITION_NOT_AVAILABLE"
  | "TRANSITION_FORBIDDEN"
  | "TRANSITION_LOCKED"
  | "CONDITION_NOT_MET"
  | "REQUIRED_FIELDS_MISSING"
  | "SLA_TIMER_FAILED"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_STATE_NOT_FOUND"
  | "WORKFLOW_TRANSITION_NOT_FOUND"
  | "WORKFLOW_HAS_ACTIVE_INSTANCES"
  | "WORKFLOW_STATE_IN_USE"
  | "WORKFLOW_ADMIN_LIST_FORBIDDEN"
  | "WORKFLOW_ADMIN_REMOVE_CREATOR_FORBIDDEN"
  | "ENTITY_TYPE_ALREADY_GOVERNED"
  | "WORKFLOW_STATE_NAME_TAKEN"
  | "WORKFLOW_INITIAL_STATE_INVALID";

export class WorkflowError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "WorkflowError";
  }
}
