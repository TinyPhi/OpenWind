import type { ConditionTree } from "@platform/workflow-engine";

export type TriggerType =
  | "workflow.entered_state"
  | "workflow.transitioned"
  | "workflow.sla_breached"
  | "field.changed"
  | "entity.created"
  | "entity.assigned"
  | "entity.due_date_overdue"
  | "comment.mentioned"
  | "comment.mention_access_granted"
  | "comment.replied"
  | "access.granted"
  | "access.revoked"
  | "system.error"
  | "schedule.cron"
  | "connector.event";

export type ActionType =
  | "notify"
  | "assign"
  | "transition"
  | "set_field"
  | "create_entity"
  | "create_child"
  | "webhook"
  | "connector.action";

export interface AutomationRule {
  id: string;
  tenantId: string;
  name: string;
  isEnabled: boolean;
  triggerType: TriggerType;
  triggerConfig: Record<string, unknown>;
  conditions: ConditionTree | null;
  actions: ActionConfig[];
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

// Action config shapes — one per ActionType variant
export interface NotifyConfig {
  recipientId?: string;
  workflowId?: string;
  channel?: string[];
  payload?: Record<string, unknown>;
}

export interface SetFieldConfig {
  instanceId?: string;
  field: string;
  value: unknown;
}

export interface TransitionConfig {
  instanceId?: string;
  transitionId: string;
  comment?: string;
}

export type WebhookActionConfig = {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  /** If true, include the full trigger event payload in the request body */
  includePayload?: boolean;
  /** Field allow-list: when includePayload is true, specifies exactly which fields to share */
  sendFields?: string[];
  timeoutMs?: number;
};

export interface AssignConfig {
  instanceId?: string;
  assigneeId: string;
}

export interface CreateEntityConfig {
  entityTypeId: string;
  fields?: Record<string, unknown>;
  assignedTo?: string;
}

export interface CreateChildConfig {
  /** Defaults to the triggering event's own entityTypeId (same-type child) when omitted. */
  entityTypeId?: string;
  assignToUserId?: string | null;
  /** `{{fieldName}}` placeholders interpolated from the PARENT's current field values. */
  descriptionTemplate?: string;
  /** Child field the interpolated description is written to. Defaults to "description". */
  descriptionField?: string;
  /** Additional static fields set on the child (merged before descriptionField). */
  fields?: Record<string, unknown>;
  /** Field on the PARENT written back with the new child's instance id. Omit to skip. */
  writeBackField?: string;
}

export type ActionConfig =
  | { type: "notify"; config: NotifyConfig }
  | { type: "set_field"; config: SetFieldConfig }
  | { type: "transition"; config: TransitionConfig }
  | { type: "webhook"; config: WebhookActionConfig }
  | { type: "assign"; config: AssignConfig }
  | { type: "create_entity"; config: CreateEntityConfig }
  | { type: "create_child"; config: CreateChildConfig }
  | { type: "connector.action"; config: Record<string, unknown> };

export type CreateAutomationRuleInput = {
  name: string;
  triggerType: TriggerType;
  triggerConfig: Record<string, unknown>;
  conditions?: ConditionTree | null | undefined;
  actions: ActionConfig[];
  isEnabled?: boolean | undefined;
  priority?: number | undefined;
};

export type UpdateAutomationRuleInput = {
  name?: string | undefined;
  isEnabled?: boolean | undefined;
  triggerType?: TriggerType | undefined;
  triggerConfig?: Record<string, unknown> | undefined;
  conditions?: ConditionTree | null | undefined;
  actions?: ActionConfig[] | undefined;
  priority?: number | undefined;
};

export class AutomationError extends Error {
  constructor(
    public readonly code:
      | "RULE_NOT_FOUND"
      | "RULE_CREATE_FAILED"
      | "MAX_DEPTH_EXCEEDED"
      | "ACTION_FAILED"
      | "INVALID_EVENT_PAYLOAD"
      | "WEBHOOK_SSRF_BLOCKED"
      | "DNS_RESOLUTION_TIMEOUT"
      | "UNKNOWN_ACTION_TYPE"
      | "CIRCUIT_BREAKER_UNAVAILABLE"
      | "NOTIFY_LINK_INVALID",
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "AutomationError";
  }
}
