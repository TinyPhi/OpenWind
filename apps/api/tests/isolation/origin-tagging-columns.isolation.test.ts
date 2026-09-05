/**
 * Isolation tests for migration 0091 (docs/specs/third-party-api-origin-tagging.md,
 * Phase 1, T2/T4) — proves the DB-level all-or-nothing CHECK constraint on
 * origin_mechanism/origin_oidc_client_id/origin_performer_user_id, on both
 * entity_instances (ticket/sub-ticket-level tag) and workflow_events
 * (comment/activity-timeline tag — comments are stored as workflow_events rows).
 *
 * This is a DB-schema-only test: no route/handler code exists yet (that's Phase
 * 2) — inserts go directly through the Drizzle client, real Postgres, RLS
 * enforced (not mocked), to prove the constraint itself, independent of
 * whatever application-layer validation Phase 2 adds on top of it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  workflows,
  workflowStates,
  workflowEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";

const TENANT = "dddddddd-0000-4000-d000-000000000090";

let entityTypeId: string;
let workflowId: string;
let instanceId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Origin Tagging Columns Test",
    slug: `origin-tagging-columns-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `origin_tagging_test_${Date.now()}`,
    plural: "origin_tagging_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "Origin tagging test workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });
  workflowId = workflow!.id;

  await db.insert(workflowStates).values({
    tenantId: TENANT,
    workflowId,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });

  const instance = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "isolation-owner",
    workflowId,
    currentState: "open",
  });
  instanceId = instance.id;
});

afterAll(async () => {
  await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db.delete(workflowStates).where(eq(workflowStates.tenantId, TENANT));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("entity_instances origin columns (migration 0091)", () => {
  it("allows all three origin columns NULL together (human, in-app creation)", async () => {
    await expect(
      db
        .update(entityInstances)
        .set({
          originMechanism: null,
          originOidcClientId: null,
          originPerformerUserId: null,
        })
        .where(eq(entityInstances.id, instanceId)),
    ).resolves.not.toThrow();
  });

  it("allows all three origin columns set together (api/handoff creation)", async () => {
    await expect(
      db
        .update(entityInstances)
        .set({
          originMechanism: "api",
          originOidcClientId: "test-client-id",
          originPerformerUserId: "test-performer",
        })
        .where(eq(entityInstances.id, instanceId)),
    ).resolves.not.toThrow();
  });

  it("rejects origin_mechanism set with the other two columns left NULL", async () => {
    await expect(
      db
        .update(entityInstances)
        .set({
          originMechanism: "api",
          originOidcClientId: null,
          originPerformerUserId: null,
        })
        .where(eq(entityInstances.id, instanceId)),
    ).rejects.toThrow();
  });

  it("rejects origin_oidc_client_id set while origin_mechanism is NULL", async () => {
    await expect(
      db
        .update(entityInstances)
        .set({
          originMechanism: null,
          originOidcClientId: "test-client-id",
          originPerformerUserId: "test-performer",
        })
        .where(eq(entityInstances.id, instanceId)),
    ).rejects.toThrow();
  });

  it("rejects an origin_mechanism value outside 'api'/'handoff'", async () => {
    await expect(
      db
        .update(entityInstances)
        .set({
          originMechanism: "not-a-real-mechanism",
          originOidcClientId: "test-client-id",
          originPerformerUserId: "test-performer",
        })
        .where(eq(entityInstances.id, instanceId)),
    ).rejects.toThrow();
  });
});

describe("workflow_events origin columns (migration 0091) — comments/timeline entries", () => {
  it("allows all three origin columns set together on a workflow_events row", async () => {
    const [event] = await db
      .insert(workflowEvents)
      .values({
        tenantId: TENANT,
        instanceId,
        workflowId,
        toState: "open",
        triggeredBy: "isolation-owner",
        comment: "origin-tagging-columns test comment",
        originMechanism: "handoff",
        originOidcClientId: "test-client-id",
        originPerformerUserId: "test-performer",
      })
      .returning({ id: workflowEvents.id });

    expect(event?.id).toBeTruthy();
  });

  it("rejects a workflow_events row with only origin_performer_user_id set", async () => {
    await expect(
      db.insert(workflowEvents).values({
        tenantId: TENANT,
        instanceId,
        workflowId,
        toState: "open",
        triggeredBy: "isolation-owner",
        comment: "should be rejected",
        originMechanism: null,
        originOidcClientId: null,
        originPerformerUserId: "test-performer",
      }),
    ).rejects.toThrow();
  });
});
