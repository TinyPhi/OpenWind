import { z } from "zod";

const baseEvent = z.object({
  version: z.literal(1),
  tenantId: z.string().uuid(),
  // In-process recursion depth at the time this event was produced. Carried
  // through the outbox so apps/worker/src/automation-worker.ts can resume
  // MAX_DEPTH enforcement across the async hop instead of resetting to 0 (#120).
  // Absent/undefined means depth 0 (a root-triggered event, e.g. a direct API call).
  depth: z.number().int().min(0).optional(),
});

export const WorkflowTransitionedV1Schema = baseEvent.extend({
  eventType: z.literal("workflow.transitioned"),
  instanceId: z.string().uuid(),
  entityTypeId: z.string().uuid(),
  workflowId: z.string().uuid(),
  fromState: z.string().nullable(),
  toState: z.string(),
  triggeredBy: z.enum(["user", "automation", "api", "system"]),
  actorId: z.string().uuid().nullable(),
  occurredAt: z.string().datetime(),
  // Automation recursion depth this transition was triggered at (see issue #120).
  // Absent on events from direct user/API transitions, which start at depth 0.
  depth: z.number().int().nonnegative().optional(),
});

export const WorkflowSlaBreachedV1Schema = baseEvent.extend({
  eventType: z.literal("workflow.sla_breached"),
  instanceId: z.string().uuid(),
  entityTypeId: z.string().uuid(),
  workflowId: z.string().uuid(),
  state: z.string(),
  slaHours: z.number().positive(),
  breachedAt: z.string().datetime(),
});

export const EntityCreatedV1Schema = baseEvent.extend({
  eventType: z.literal("entity.created"),
  instanceId: z.string().uuid(),
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()),
  createdBy: z.string().uuid().nullable(),
});

export const EntityAssignedV1Schema = baseEvent.extend({
  eventType: z.literal("entity.assigned"),
  instanceId: z.string().uuid(),
  entityTypeId: z.string().uuid(),
  assigneeId: z.string().uuid(),
  assignedBy: z.string().uuid().nullable(),
});

export const EntityDueDateOverdueV1Schema = baseEvent.extend({
  eventType: z.literal("entity.due_date_overdue"),
  instanceId: z.string().uuid(),
  entityTypeId: z.string().uuid(),
  dueDate: z.string().datetime(),
  overdueAt: z.string().datetime(),
});

export const CommentMentionedV1Schema = baseEvent.extend({
  eventType: z.literal("comment.mentioned"),
  instanceId: z.string().uuid(),
  actorId: z.string(),
  mentionedUserIds: z.array(z.string()).min(1),
});

// Distinct from CommentMentionedV1Schema: fires only for mentioned users who
// had no prior access and were granted brand-new access by this mention (see
// add-comment.ts) — a different, more specific message than a plain mention.
export const CommentMentionAccessGrantedV1Schema = baseEvent.extend({
  eventType: z.literal("comment.mention_access_granted"),
  instanceId: z.string().uuid(),
  actorId: z.string(),
  mentionedUserIds: z.array(z.string()).min(1),
});

export const CommentRepliedV1Schema = baseEvent.extend({
  eventType: z.literal("comment.replied"),
  instanceId: z.string().uuid(),
  actorId: z.string(),
  targetUserId: z.string(),
});

export const AccessGrantedV1Schema = baseEvent.extend({
  eventType: z.literal("access.granted"),
  instanceId: z.string().uuid(),
  actorId: z.string(),
  targetUserId: z.string(),
});

export const AccessRevokedV1Schema = baseEvent.extend({
  eventType: z.literal("access.revoked"),
  instanceId: z.string().uuid(),
  actorId: z.string(),
  targetUserId: z.string(),
});

export const SystemErrorV1Schema = baseEvent.extend({
  eventType: z.literal("system.error"),
  context: z.record(z.unknown()),
  reason: z.string(),
});

export const TriggerEventSchema = z.discriminatedUnion("eventType", [
  WorkflowTransitionedV1Schema,
  WorkflowSlaBreachedV1Schema,
  EntityCreatedV1Schema,
  EntityAssignedV1Schema,
  EntityDueDateOverdueV1Schema,
  CommentMentionedV1Schema,
  CommentMentionAccessGrantedV1Schema,
  CommentRepliedV1Schema,
  AccessGrantedV1Schema,
  AccessRevokedV1Schema,
  SystemErrorV1Schema,
]);

// Extracts just `depth` from an outbox payload before the full TriggerEventSchema
// parse — apps/worker/src/automation-worker.ts needs it to call
// executeAutomationRules with the right depth argument (#120), one step before
// that function does its own full TriggerEventSchema.safeParse. Reuses
// baseEvent's `depth` constraint so the two never drift apart.
export const OutboxDepthSchema = baseEvent.pick({ depth: true });

export type WorkflowTransitionedV1 = z.infer<
  typeof WorkflowTransitionedV1Schema
>;
export type WorkflowSlaBreachedV1 = z.infer<typeof WorkflowSlaBreachedV1Schema>;
export type EntityCreatedV1 = z.infer<typeof EntityCreatedV1Schema>;
export type EntityAssignedV1 = z.infer<typeof EntityAssignedV1Schema>;
export type EntityDueDateOverdueV1 = z.infer<
  typeof EntityDueDateOverdueV1Schema
>;
export type CommentMentionedV1 = z.infer<typeof CommentMentionedV1Schema>;
export type CommentMentionAccessGrantedV1 = z.infer<
  typeof CommentMentionAccessGrantedV1Schema
>;
export type CommentRepliedV1 = z.infer<typeof CommentRepliedV1Schema>;
export type AccessGrantedV1 = z.infer<typeof AccessGrantedV1Schema>;
export type AccessRevokedV1 = z.infer<typeof AccessRevokedV1Schema>;
export type SystemErrorV1 = z.infer<typeof SystemErrorV1Schema>;
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;
