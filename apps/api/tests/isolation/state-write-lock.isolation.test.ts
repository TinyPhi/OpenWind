/**
 * docs/specs/state-override.md, docs/specs/segregation-of-duties.md: a workflow whose transitions
 * carry an actor rule, or that switched the admin override on, cannot have its records' step
 * written directly. The column write skips the transition guards, so without this a rule
 * would bind nobody who simply asked for the state. A workflow with neither keeps the old path.
 *
 * Real Postgres through withTenantContext (RLS as app_user).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  withTenantContext,
  entityInstances,
  entityRelations,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
} from "@platform/db";
import {
  createEntity,
  updateEntity,
  setEntityState,
  bulkSetState,
  EntityError,
} from "@platform/entity-engine";

const TENANT = "ffffffff-0775-4000-a000-000000000077";
const OTHER_TENANT = "ffffffff-0775-4000-b000-000000000078";

type Kind = "rule" | "switch" | "plain";
const workflowIds = new Map<Kind, string>();
let otherTenantRuleWorkflowId: string;
const entityTypeIds = new Map<Kind, string>();
const allEntityTypeIds: string[] = [];
const instanceIds: string[] = [];

async function newInstance(kind: Kind): Promise<string> {
  const [row] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId: entityTypeIds.get(kind) as string, // seeded for every kind in beforeAll
      workflowId: workflowIds.get(kind) as string,
      currentState: "draft",
      fields: {},
      createdBy: "u-creator",
    })
    .returning({ id: entityInstances.id });
  if (!row) throw new Error("instance insert failed");
  instanceIds.push(row.id);
  return row.id;
}

async function refused(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return (
      err instanceof EntityError && err.code === "STATE_CHANGE_NOT_ALLOWED"
    );
  }
}

async function seedWorkflow(
  tenantId: string,
  kind: Kind,
  entityTypeId: string,
): Promise<string> {
  const [wf] = await db
    .insert(workflows)
    .values({
      tenantId,
      entityTypeId,
      name: `lock ${kind}`,
      initialState: "draft",
      allowStateOverride: kind === "switch",
    })
    .returning({ id: workflows.id });
  if (!wf) throw new Error("workflow insert failed");
  await db.insert(workflowStates).values(
    ["draft", "review", "closed"].map((name, i) => ({
      tenantId,
      workflowId: wf.id,
      name,
      label: name,
      isTerminal: false,
      sortOrder: i,
    })),
  );
  await db.insert(workflowTransitions).values({
    tenantId,
    workflowId: wf.id,
    fromState: "draft",
    toState: "review",
    label: "go",
    allowedRoles: [],
    conditions: kind === "rule" ? { op: "actor_not_creator" } : null,
    requiresComment: false,
    requiresFields: [],
  });
  return wf.id;
}

beforeAll(async () => {
  const ts = Date.now();
  for (const kind of ["rule", "switch", "plain"] as const) {
    const [et] = await db
      .insert(entityTypes)
      .values({
        tenantId: null,
        name: `isolation_swl_${kind}_${ts}`,
        plural: `isolation_swl_${kind}s_${ts}`,
        allowCustomFields: true,
      })
      .returning({ id: entityTypes.id });
    if (!et) throw new Error("entity type insert failed");
    entityTypeIds.set(kind, et.id);
    allEntityTypeIds.push(et.id);
    workflowIds.set(kind, await seedWorkflow(TENANT, kind, et.id));
  }
  otherTenantRuleWorkflowId = await seedWorkflow(
    OTHER_TENANT,
    "rule",
    entityTypeIds.get("rule") as string,
  );
});

afterAll(async () => {
  if (instanceIds.length > 0) {
    await db
      .delete(entityRelations)
      .where(inArray(entityRelations.fromInstanceId, instanceIds));
    await db
      .delete(workflowEvents)
      .where(inArray(workflowEvents.instanceId, instanceIds));
    await db
      .delete(entityInstances)
      .where(inArray(entityInstances.id, instanceIds));
  }
  for (const tenantId of [TENANT, OTHER_TENANT]) {
    await db
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.tenantId, tenantId));
    await db
      .delete(workflowStates)
      .where(eq(workflowStates.tenantId, tenantId));
    await db.delete(workflows).where(eq(workflows.tenantId, tenantId));
  }
  if (allEntityTypeIds.length > 0) {
    await db
      .delete(entityTypes)
      .where(inArray(entityTypes.id, allEntityTypeIds));
  }
});

describe("direct state writes on a workflow that uses actor rules or the override", () => {
  it("refuses updateEntity moving a record whose workflow has an actor rule", async () => {
    const id = await newInstance("rule");
    expect(
      await refused(
        withTenantContext(TENANT, (tx) =>
          updateEntity(tx, TENANT, id, { currentState: "review" }),
        ),
      ),
    ).toBe(true);
    const [row] = await db
      .select({ s: entityInstances.currentState })
      .from(entityInstances)
      .where(eq(entityInstances.id, id));
    expect(row?.s).toBe("draft");
  });

  it("refuses updateEntity when the workflow has switched the override on", async () => {
    const id = await newInstance("switch");
    expect(
      await refused(
        withTenantContext(TENANT, (tx) =>
          updateEntity(tx, TENANT, id, { currentState: "review" }),
        ),
      ),
    ).toBe(true);
  });

  it("still lets updateEntity write the same state and move a plain workflow's record", async () => {
    const lockedId = await newInstance("rule");
    await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, lockedId, { currentState: "draft" }),
    );
    const plainId = await newInstance("plain");
    const moved = await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, plainId, { currentState: "review" }),
    );
    expect(moved.currentState).toBe("review");
  });

  it("refuses setEntityState on a locked workflow and allows it on a plain one", async () => {
    const lockedId = await newInstance("rule");
    expect(
      await refused(
        withTenantContext(TENANT, (tx) =>
          setEntityState(tx, TENANT, lockedId, "review", "u-admin"),
        ),
      ),
    ).toBe(true);
    const plainId = await newInstance("plain");
    const moved = await withTenantContext(TENANT, (tx) =>
      setEntityState(tx, TENANT, plainId, "review", "u-admin"),
    );
    expect(moved.currentState).toBe("review");
  });

  it("reports STATE_CHANGE_NOT_ALLOWED per item in bulkSetState and moves the rest", async () => {
    const lockedId = await newInstance("rule");
    const switchId = await newInstance("switch");
    const plainId = await newInstance("plain");
    const result = await withTenantContext(TENANT, (tx) =>
      bulkSetState(
        tx,
        TENANT,
        [
          { id: lockedId, state: "review" },
          { id: switchId, state: "review" },
          { id: plainId, state: "review" },
        ],
        "u-admin",
      ),
    );
    expect(result.updatedIds).toEqual([plainId]);
    expect(result.errors.map((e) => [e.id, e.code]).sort()).toEqual(
      [
        [lockedId, "STATE_CHANGE_NOT_ALLOWED"],
        [switchId, "STATE_CHANGE_NOT_ALLOWED"],
      ].sort(),
    );
  });

  const CREATE = {
    fields: { title: "t" },
    dueDate: new Date(Date.now() + 86_400_000).toISOString(),
    remark: "why",
    severity: "medium" as const,
    assignedTo: "u-assignee",
    createdBy: "u-creator",
  };

  it("refuses creating in a later step when the caller enforces the initial state, and allows the initial one", async () => {
    const workflowId = workflowIds.get("rule") as string;
    expect(
      await refused(
        withTenantContext(TENANT, (tx) =>
          createEntity(tx, TENANT, {
            ...CREATE,
            entityTypeId: entityTypeIds.get("rule") as string,
            workflowId,
            currentState: "review",
            enforceInitialState: true,
          }),
        ),
      ),
    ).toBe(true);
    const ok = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        ...CREATE,
        entityTypeId: entityTypeIds.get("rule") as string,
        workflowId,
        currentState: "draft",
        enforceInitialState: true,
      }),
    );
    instanceIds.push(ok.id);
    expect(ok.currentState).toBe("draft");
  });

  it("leaves create unrestricted without the flag and on a plain workflow", async () => {
    const seeded = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        ...CREATE,
        entityTypeId: entityTypeIds.get("rule") as string,
        workflowId: workflowIds.get("rule") as string,
        currentState: "review",
      }),
    );
    instanceIds.push(seeded.id);
    expect(seeded.currentState).toBe("review");
    const plain = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        ...CREATE,
        entityTypeId: entityTypeIds.get("plain") as string,
        workflowId: workflowIds.get("plain") as string,
        currentState: "review",
        enforceInitialState: true,
      }),
    );
    instanceIds.push(plain.id);
    expect(plain.currentState).toBe("review");
  });

  it("does not let another tenant's rule or switch lock this tenant's plain workflow", async () => {
    // The other tenant has an actor-rule workflow; a plain-workflow record in this tenant stays writable.
    expect(otherTenantRuleWorkflowId).toBeDefined();
    const plainId = await newInstance("plain");
    const moved = await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, plainId, { currentState: "review" }),
    );
    expect(moved.currentState).toBe("review");
  });

  it("does not let attaching a record under a parent turn the child-ticket states into a way past the lock", async () => {
    // A record of a locked workflow is moved under a parent, so the engine treats it as a child
    // ticket (fixed open/in-progress/closed states). "closed" is also a step of its own workflow,
    // so writing it would skip the transition rules; "in-progress" is not one of its steps.
    const childId = await newInstance("rule");
    const parentId = await newInstance("plain");
    await db.insert(entityRelations).values({
      tenantId: TENANT,
      fromInstanceId: childId,
      toInstanceId: parentId,
      relationType: "child_of",
    });

    expect(
      await refused(
        withTenantContext(TENANT, (tx) =>
          updateEntity(tx, TENANT, childId, { currentState: "closed" }),
        ),
      ),
    ).toBe(true);
    expect(
      await refused(
        withTenantContext(TENANT, (tx) =>
          setEntityState(tx, TENANT, childId, "closed", "u-agent"),
        ),
      ),
    ).toBe(true);
    const bulk = await withTenantContext(TENANT, (tx) =>
      bulkSetState(tx, TENANT, [{ id: childId, state: "closed" }], "u-agent"),
    );
    expect(bulk.updatedIds).toEqual([]);
    expect(bulk.errors.map((e) => e.code)).toEqual([
      "STATE_CHANGE_NOT_ALLOWED",
    ]);

    const moved = await withTenantContext(TENANT, (tx) =>
      updateEntity(tx, TENANT, childId, { currentState: "in-progress" }),
    );
    expect(moved.currentState).toBe("in-progress");
  });
});
