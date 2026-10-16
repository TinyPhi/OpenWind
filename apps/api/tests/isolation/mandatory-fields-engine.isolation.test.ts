/**
 * docs/specs/mandatory-ticket-fields.md R4 (PR 2.1), against a real database:
 * - a team assignment survives on an entity type with no team_id field (B4), and only a team
 *   of the same tenant is accepted -- on create and on sub-task create;
 * - a record's workflow must run its own entity type;
 * - a workflow record missing a mandatory value is created and logged under "log", and
 *   rejected under "enforce".
 *
 * Uses its own freshly generated tenants, so leftovers from other suites can't collide.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  teams,
  workflows,
  entityFields,
} from "@platform/db";
import {
  createEntityType,
  createEntity,
  createChildRelation,
  setMandatoryFieldsMode,
  ValidationError,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ALL_TENANTS = [TENANT_A, TENANT_B];

let ticketType: EntityType;
let otherType: EntityType;
let workflowId: string;
let otherWorkflowId: string;
let teamA: string;
let teamB: string;

const FUTURE = (): string =>
  new Date(Date.now() + 3 * 86_400_000).toISOString();

function complete(extra: Record<string, unknown> = {}): {
  entityTypeId: string;
  workflowId: string;
  fields: Record<string, unknown>;
  dueDate: string;
  remark: string;
  severity: "medium";
  assignedTo?: string;
  teamId?: string;
} {
  return {
    entityTypeId: ticketType.id,
    workflowId,
    fields: { title: "Printer offline" },
    dueDate: FUTURE(),
    remark: "Reported at the front desk",
    severity: "medium",
    assignedTo: "395069484982800101",
    ...extra,
  };
}

async function expectValidationField(
  promise: Promise<unknown>,
  field: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect(
    (thrown as InstanceType<typeof ValidationError>).fields.map((f) => f.field),
  ).toContain(field);
}

beforeAll(async () => {
  await db.insert(tenants).values(
    ALL_TENANTS.map((id) => ({
      id,
      name: `mandatory-fields ${id}`,
      slug: `mandatory-fields-${id}`,
    })),
  );

  await withTenantContext(TENANT_A, async (tx) => {
    ticketType = await createEntityType(tx, TENANT_A, {
      name: `mf_ticket_${Date.now()}`,
      plural: "mf_tickets",
      allowCustomFields: true,
    });
    otherType = await createEntityType(tx, TENANT_A, {
      name: `mf_other_${Date.now()}`,
      plural: "mf_others",
      allowCustomFields: true,
    });
    // Like the helpdesk ticket: no team_id field, so the type schema would strip it.
    await tx
      .delete(entityFields)
      .where(
        and(
          eq(entityFields.entityTypeId, ticketType.id),
          eq(entityFields.name, "team_id"),
        ),
      );
    const [wf] = await tx
      .insert(workflows)
      .values({
        tenantId: TENANT_A,
        entityTypeId: ticketType.id,
        name: "MF Support",
        initialState: "open",
      })
      .returning({ id: workflows.id });
    const [otherWf] = await tx
      .insert(workflows)
      .values({
        tenantId: TENANT_A,
        entityTypeId: otherType.id,
        name: "MF Other",
        initialState: "open",
      })
      .returning({ id: workflows.id });
    workflowId = wf!.id;
    otherWorkflowId = otherWf!.id;
    const [team] = await tx
      .insert(teams)
      .values({ tenantId: TENANT_A, name: "Platform", createdBy: "u-a" })
      .returning({ id: teams.id });
    teamA = team!.id;
  });
  await withTenantContext(TENANT_B, async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ tenantId: TENANT_B, name: "Other org", createdBy: "u-b" })
      .returning({ id: teams.id });
    teamB = team!.id;
  });
});

afterEach(() => {
  setMandatoryFieldsMode("log");
});

afterAll(async () => {
  for (const table of [
    "entity_relations",
    "workflow_events",
    "outbox_events",
    "entity_instances",
    "workflow_states",
    "workflows",
    "entity_fields",
    "entity_types",
    "teams",
  ]) {
    await db.execute(
      sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id IN (${sql.join(
        ALL_TENANTS.map((t) => sql`${t}::uuid`),
        sql`, `,
      )})`,
    );
  }
  await db.delete(tenants).where(inArray(tenants.id, ALL_TENANTS));
});

describe("mandatory fields — engine create paths (PR 2.1)", () => {
  it("keeps a team assignment on a type with no team_id field (B4)", async () => {
    const created = await withTenantContext(TENANT_A, (tx) =>
      createEntity(
        tx,
        TENANT_A,
        complete({ assignedTo: undefined, teamId: teamA }),
      ),
    );
    expect(created.fields["team_id"]).toBe(teamA);
  });

  it("rejects another tenant's team, on create and on sub-task create", async () => {
    await expectValidationField(
      withTenantContext(TENANT_A, (tx) =>
        createEntity(
          tx,
          TENANT_A,
          complete({ assignedTo: undefined, teamId: teamB }),
        ),
      ),
      "teamId",
    );

    const parent = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, complete()),
    );
    await expectValidationField(
      withTenantContext(TENANT_A, (tx) =>
        createChildRelation(tx, TENANT_A, {
          parentId: parent.id,
          entityTypeId: ticketType.id,
          childFields: { title: "Swap the toner" },
          teamId: teamB,
          dueDate: FUTURE(),
          remark: "Needed today",
        }),
      ),
      "teamId",
    );
  });

  it("doesn't let a team in the fields bag route a ticket, nor block the create", async () => {
    const created = await withTenantContext(TENANT_A, (tx) =>
      createEntity(
        tx,
        TENANT_A,
        complete({ fields: { title: "Printer offline", team_id: teamB } }),
      ),
    );
    expect(created.fields["team_id"]).toBeUndefined();
  });

  it("rejects a workflow that runs a different entity type", async () => {
    await expectValidationField(
      withTenantContext(TENANT_A, (tx) =>
        createEntity(tx, TENANT_A, complete({ workflowId: otherWorkflowId })),
      ),
      "workflowId",
    );
  });

  it("creates a record missing a mandatory value under log, and rejects it under enforce", async () => {
    const missingRemark = complete({ remark: undefined });

    const logged = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, missingRemark),
    );
    expect(logged.id).toBeTruthy();

    setMandatoryFieldsMode("enforce");
    await expectValidationField(
      withTenantContext(TENANT_A, (tx) =>
        createEntity(tx, TENANT_A, missingRemark),
      ),
      "remark",
    );
    // A record whose type has a workflow counts even when the caller leaves workflowId out.
    await expectValidationField(
      withTenantContext(TENANT_A, (tx) =>
        createEntity(tx, TENANT_A, {
          ...complete({ dueDate: undefined }),
          workflowId: undefined,
        }),
      ),
      "dueDate",
    );
  });

  it("rejects a sub-task without a title under enforce", async () => {
    const parent = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, complete()),
    );
    setMandatoryFieldsMode("enforce");
    await expectValidationField(
      withTenantContext(TENANT_A, (tx) =>
        createChildRelation(tx, TENANT_A, {
          parentId: parent.id,
          entityTypeId: ticketType.id,
          childFields: {},
          assignedTo: "395069484982800101",
          dueDate: FUTURE(),
          remark: "Needed today",
        }),
      ),
      "title",
    );
  });

  it("still creates a partner ticket whose assignee couldn't be resolved (ADR-012 exemption)", async () => {
    setMandatoryFieldsMode("enforce");
    const created = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        ...complete({ assignedTo: undefined }),
        mandatoryExemption: "partner_unresolved_assignee",
      }),
    );
    expect(created.assignedTo).toBeNull();
  });
});
