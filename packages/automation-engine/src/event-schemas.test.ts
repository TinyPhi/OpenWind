import { describe, it, expect } from "vitest";
import {
  WorkflowTransitionedV1Schema,
  EntityCreatedV1Schema,
  EntityAssignedV1Schema,
  EntityUnassignedV1Schema,
  EntityUpdatedV1Schema,
} from "./event-schemas.js";

// docs/specs/port-nexus-ow-fixes.md R2 -- assigneeId/assignedBy/previousAssigneeId/
// actorId/createdBy previously required z.string().uuid(), which threw
// INVALID_EVENT_PAYLOAD for non-UUID ids (e.g. AuthNexus's numeric-string ids),
// silently dead-lettering every assignment/unassignment/creation/transition
// automation trigger. Relaxed to z.string().min(1).max(255) -- these tests
// prove the relaxation without opening the field up to unbounded input.

const NON_UUID_ID = "12345";
const VALID_UUID = "aaaaaaaa-3333-4000-a000-000000000036";
const OVER_255 = "a".repeat(256);

function baseFields() {
  return {
    version: 1 as const,
    tenantId: VALID_UUID,
  };
}

describe("WorkflowTransitionedV1Schema.actorId", () => {
  const build = (actorId: string | null) => ({
    ...baseFields(),
    eventType: "workflow.transitioned" as const,
    instanceId: VALID_UUID,
    entityTypeId: VALID_UUID,
    workflowId: VALID_UUID,
    fromState: null,
    toState: "in_progress",
    triggeredBy: "user" as const,
    actorId,
    occurredAt: new Date().toISOString(),
  });

  it("accepts a non-UUID id", () => {
    expect(
      WorkflowTransitionedV1Schema.safeParse(build(NON_UUID_ID)).success,
    ).toBe(true);
  });

  it("still accepts a valid UUID", () => {
    expect(
      WorkflowTransitionedV1Schema.safeParse(build(VALID_UUID)).success,
    ).toBe(true);
  });

  it("accepts null", () => {
    expect(WorkflowTransitionedV1Schema.safeParse(build(null)).success).toBe(
      true,
    );
  });

  it("rejects an empty string", () => {
    expect(WorkflowTransitionedV1Schema.safeParse(build("")).success).toBe(
      false,
    );
  });

  it("rejects a string over 255 characters", () => {
    expect(
      WorkflowTransitionedV1Schema.safeParse(build(OVER_255)).success,
    ).toBe(false);
  });
});

describe("EntityCreatedV1Schema.createdBy", () => {
  const build = (createdBy: string | null) => ({
    ...baseFields(),
    eventType: "entity.created" as const,
    instanceId: VALID_UUID,
    entityTypeId: VALID_UUID,
    fields: {},
    createdBy,
  });

  it("accepts a non-UUID id", () => {
    expect(EntityCreatedV1Schema.safeParse(build(NON_UUID_ID)).success).toBe(
      true,
    );
  });

  it("rejects an empty string", () => {
    expect(EntityCreatedV1Schema.safeParse(build("")).success).toBe(false);
  });

  it("rejects a string over 255 characters", () => {
    expect(EntityCreatedV1Schema.safeParse(build(OVER_255)).success).toBe(
      false,
    );
  });
});

describe("EntityAssignedV1Schema.assigneeId / assignedBy", () => {
  const build = (assigneeId: string, assignedBy: string | null) => ({
    ...baseFields(),
    eventType: "entity.assigned" as const,
    instanceId: VALID_UUID,
    entityTypeId: VALID_UUID,
    assigneeId,
    assignedBy,
  });

  it("accepts non-UUID ids for both fields", () => {
    expect(
      EntityAssignedV1Schema.safeParse(build(NON_UUID_ID, NON_UUID_ID)).success,
    ).toBe(true);
  });

  it("still accepts valid UUIDs", () => {
    expect(
      EntityAssignedV1Schema.safeParse(build(VALID_UUID, VALID_UUID)).success,
    ).toBe(true);
  });

  it("rejects an empty assigneeId (required, non-nullable)", () => {
    expect(
      EntityAssignedV1Schema.safeParse(build("", VALID_UUID)).success,
    ).toBe(false);
  });

  it("rejects an over-255-char assignedBy", () => {
    expect(
      EntityAssignedV1Schema.safeParse(build(NON_UUID_ID, OVER_255)).success,
    ).toBe(false);
  });
});

describe("EntityUnassignedV1Schema.previousAssigneeId / actorId", () => {
  const build = (previousAssigneeId: string, actorId: string | null) => ({
    ...baseFields(),
    eventType: "entity.unassigned" as const,
    instanceId: VALID_UUID,
    entityTypeId: VALID_UUID,
    previousAssigneeId,
    actorId,
  });

  it("accepts non-UUID ids for both fields", () => {
    expect(
      EntityUnassignedV1Schema.safeParse(build(NON_UUID_ID, NON_UUID_ID))
        .success,
    ).toBe(true);
  });

  it("still accepts valid UUIDs", () => {
    expect(
      EntityUnassignedV1Schema.safeParse(build(VALID_UUID, VALID_UUID)).success,
    ).toBe(true);
  });

  it("accepts null actorId", () => {
    expect(
      EntityUnassignedV1Schema.safeParse(build(NON_UUID_ID, null)).success,
    ).toBe(true);
  });

  it("rejects an empty previousAssigneeId (required, non-nullable)", () => {
    expect(
      EntityUnassignedV1Schema.safeParse(build("", VALID_UUID)).success,
    ).toBe(false);
  });

  it("rejects an over-255-char actorId", () => {
    expect(
      EntityUnassignedV1Schema.safeParse(build(NON_UUID_ID, OVER_255)).success,
    ).toBe(false);
  });
});

describe("EntityUpdatedV1Schema.entityTypeId / changed (Vijit review, PR #597 B1)", () => {
  // Outbox rows written before entity.updated was added to the poller's
  // allowlist never populated entityTypeId/changed -- those stale rows must
  // still parse instead of dead-lettering into BullMQ retries/DLQ on deploy.
  const staleRow = {
    ...baseFields(),
    eventType: "entity.updated" as const,
    instanceId: VALID_UUID,
    actorId: null,
  };

  it("accepts a stale row with neither entityTypeId nor changed", () => {
    expect(EntityUpdatedV1Schema.safeParse(staleRow).success).toBe(true);
  });

  it("still accepts a well-formed row with both fields present", () => {
    expect(
      EntityUpdatedV1Schema.safeParse({
        ...staleRow,
        entityTypeId: VALID_UUID,
        changed: { team_id: { old: null, new: "team-1" } },
      }).success,
    ).toBe(true);
  });
});
