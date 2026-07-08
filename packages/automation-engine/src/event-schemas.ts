import { z } from "zod";

const baseEvent = z.object({
  version: z.literal(1),
  tenantId: z.string().uuid(),
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

export const TriggerEventSchema = z.discriminatedUnion("eventType", [
  WorkflowTransitionedV1Schema,
  WorkflowSlaBreachedV1Schema,
  EntityCreatedV1Schema,
  EntityAssignedV1Schema,
]);

export type WorkflowTransitionedV1 = z.infer<
  typeof WorkflowTransitionedV1Schema
>;
export type WorkflowSlaBreachedV1 = z.infer<typeof WorkflowSlaBreachedV1Schema>;
export type EntityCreatedV1 = z.infer<typeof EntityCreatedV1Schema>;
export type EntityAssignedV1 = z.infer<typeof EntityAssignedV1Schema>;
export type TriggerEvent = z.infer<typeof TriggerEventSchema>;
