/**
 * Segregation-of-duties transition conditions (docs/specs/segregation-of-duties.md).
 *
 * Real Postgres, and every engine call goes through withTenantContext, so RLS is active as
 * app_user. The workflow below is draft -> review -> final -> done:
 *   submit  draft -> review   no rule
 *   approve review -> final   actor_not_creator AND actor_not_prior_actor
 *   close   final -> done     actor_not_prior_actor limited to people who left `review`
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  withTenantContext,
  entityInstances,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
} from "@platform/db";
import {
  executeTransition,
  getAvailableTransitions,
  addWorkflowState,
  updateWorkflowState,
  deleteWorkflowState,
  addWorkflowTransition,
  updateWorkflowTransition,
  WorkflowError,
} from "@platform/workflow-engine";

const TENANT = "ffffffff-0775-4000-a000-000000000001";
const OTHER_TENANT = "ffffffff-0775-4000-b000-000000000002";

const CREATOR = "u-775-creator";
const SUBMITTER = "u-775-submitter";
const APPROVER = "u-775-approver";
const BYSTANDER = "u-775-bystander";

let entityTypeId: string;
let workflowId: string;
let submitId: string;
let approveId: string;
let closeId: string;
let withdrawId: string;
let notRuleId: string;
const instanceIds: string[] = [];

async function newInstance(tenantId = TENANT): Promise<string> {
  const [row] = await db
    .insert(entityInstances)
    .values({
      tenantId,
      entityTypeId,
      workflowId: tenantId === TENANT ? workflowId : otherWorkflowId,
      currentState: "draft",
      fields: {},
      createdBy: CREATOR,
    })
    .returning({ id: entityInstances.id });
  if (!row) throw new Error("instance insert failed");
  instanceIds.push(row.id);
  return row.id;
}

let otherWorkflowId: string;

function act(
  instanceId: string,
  transitionId: string,
  actorId: string | undefined,
  tenantId = TENANT,
) {
  return withTenantContext(tenantId, (tx) =>
    executeTransition(tx, tenantId, {
      instanceId,
      transitionId,
      ...(actorId !== undefined && { actorId }),
      actorRoles: ["agent"],
    }),
  );
}

async function conditionNotMet(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return err instanceof WorkflowError && err.code === "CONDITION_NOT_MET";
  }
}

beforeAll(async () => {
  const ts = Date.now();
  const [et] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_sod_${ts}`,
      plural: `isolation_sods_${ts}`,
      allowCustomFields: true,
    })
    .returning({ id: entityTypes.id });
  if (!et) throw new Error("entity type insert failed");
  entityTypeId = et.id;

  for (const tenantId of [TENANT, OTHER_TENANT]) {
    const [wf] = await db
      .insert(workflows)
      .values({
        tenantId,
        entityTypeId,
        name: "SoD workflow",
        initialState: "draft",
      })
      .returning({ id: workflows.id });
    if (!wf) throw new Error("workflow insert failed");
    if (tenantId === TENANT) workflowId = wf.id;
    else otherWorkflowId = wf.id;

    await db.insert(workflowStates).values(
      ["draft", "review", "final", "done"].map((name, i) => ({
        tenantId,
        workflowId: wf.id,
        name,
        label: name,
        isTerminal: name === "done",
        sortOrder: i,
      })),
    );

    const rows = await db
      .insert(workflowTransitions)
      .values([
        {
          tenantId,
          workflowId: wf.id,
          fromState: "draft",
          toState: "review",
          label: "submit",
          allowedRoles: [],
          requiresComment: false,
          requiresFields: [],
        },
        {
          tenantId,
          workflowId: wf.id,
          fromState: "review",
          toState: "final",
          label: "approve",
          allowedRoles: [],
          conditions: {
            op: "and",
            children: [
              { op: "actor_not_creator" },
              { op: "actor_not_prior_actor" },
            ],
          },
          requiresComment: false,
          requiresFields: [],
        },
        {
          tenantId,
          workflowId: wf.id,
          fromState: "final",
          toState: "done",
          label: "close",
          allowedRoles: [],
          conditions: { op: "actor_not_prior_actor", states: ["review"] },
          requiresComment: false,
          requiresFields: [],
        },
        {
          tenantId,
          workflowId: wf.id,
          fromState: "review",
          toState: "draft",
          label: "withdraw",
          allowedRoles: [],
          conditions: { op: "actor_is_creator" },
          requiresComment: false,
          requiresFields: [],
        },
        {
          // Written straight to the table, as seed SQL could: the write-time schema rejects
          // a `not` over an actor rule, so the engine must refuse it on its own.
          tenantId,
          workflowId: wf.id,
          fromState: "final",
          toState: "review",
          label: "reopen",
          allowedRoles: [],
          conditions: { op: "not", child: { op: "actor_not_creator" } },
          requiresComment: false,
          requiresFields: [],
        },
      ])
      .returning({
        id: workflowTransitions.id,
        label: workflowTransitions.label,
      });
    if (tenantId === TENANT) {
      submitId = rows.find((r) => r.label === "submit")?.id ?? "";
      approveId = rows.find((r) => r.label === "approve")?.id ?? "";
      closeId = rows.find((r) => r.label === "close")?.id ?? "";
      withdrawId = rows.find((r) => r.label === "withdraw")?.id ?? "";
      notRuleId = rows.find((r) => r.label === "reopen")?.id ?? "";
    }
  }
});

afterAll(async () => {
  if (instanceIds.length > 0) {
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
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

describe("actor_not_creator", () => {
  it("refuses the person who created the record", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    expect(await conditionNotMet(act(id, approveId, CREATOR))).toBe(true);
  });

  it("lets someone else take the same transition", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    const event = await act(id, approveId, APPROVER);

    expect(event.toState).toBe("final");
    expect(event.actorId).toBe(APPROVER);
  });
});

describe("actor_not_prior_actor", () => {
  it("refuses someone who already acted on this instance (the submitter cannot approve)", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    expect(await conditionNotMet(act(id, approveId, SUBMITTER))).toBe(true);
  });

  it("with `states`, only counts earlier steps that left those states", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER); // left draft
    await act(id, approveId, APPROVER); // left review

    // The approver left `review`, so may not close; the submitter left only `draft`.
    expect(await conditionNotMet(act(id, closeId, APPROVER))).toBe(true);
    const event = await act(id, closeId, SUBMITTER);
    expect(event.toState).toBe("done");
  });

  it("does not count comments as acting", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);
    await db.insert(workflowEvents).values({
      tenantId: TENANT,
      instanceId: id,
      workflowId,
      fromState: "review",
      toState: "review",
      triggeredBy: "user",
      actorId: BYSTANDER,
      metadata: { type: "comment", text: "looks fine to me" },
    });

    const event = await act(id, approveId, BYSTANDER);

    expect(event.toState).toBe("final");
  });

  it("only looks at this instance's history", async () => {
    const first = await newInstance();
    await act(first, submitId, SUBMITTER);
    await act(first, approveId, APPROVER);

    const second = await newInstance();
    await act(second, submitId, SUBMITTER);

    // APPROVER acted on `first`, but has never touched `second`.
    expect((await act(second, approveId, APPROVER)).toState).toBe("final");
  });
});

describe("actor_is_creator", () => {
  it("lets only the creator take a creator-only transition", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    expect(await conditionNotMet(act(id, withdrawId, SUBMITTER))).toBe(true);
    expect((await act(id, withdrawId, CREATOR)).toState).toBe("draft");
  });

  it("refuses an unidentified actor", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    expect(await conditionNotMet(act(id, withdrawId, undefined))).toBe(true);
  });
});

describe("evasion attempts", () => {
  it("a transition sent with metadata {type:'comment'} still counts as acting", async () => {
    const id = await newInstance();
    await withTenantContext(TENANT, (tx) =>
      executeTransition(tx, TENANT, {
        instanceId: id,
        transitionId: submitId,
        actorId: SUBMITTER,
        actorRoles: ["agent"],
        // Caller-written metadata must not decide whether this row is a transition.
        metadata: { type: "comment", text: "just a note" },
      }),
    );

    expect(await conditionNotMet(act(id, approveId, SUBMITTER))).toBe(true);
  });

  it.each(["apikey:5d1c7e0a-0000-4000-8000-000000000001", "system", ""])(
    "an API-key or system identity (%j) cannot satisfy an actor rule",
    async (actor) => {
      const id = await newInstance();
      await act(id, submitId, SUBMITTER);

      expect(await conditionNotMet(act(id, approveId, actor))).toBe(true);
      expect(await conditionNotMet(act(id, withdrawId, actor))).toBe(true);
    },
  );

  it("tag, severity and other same-state events do not count as acting", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);
    await db.insert(workflowEvents).values({
      tenantId: TENANT,
      instanceId: id,
      workflowId,
      fromState: "review",
      toState: "review",
      triggeredBy: "user",
      actorId: BYSTANDER,
      metadata: { type: "tag", tag: "urgent" },
    });

    expect((await act(id, approveId, BYSTANDER)).toState).toBe("final");
  });

  it("a stored `not` over an actor rule (bypassing the schema) is never satisfied", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);
    await act(id, approveId, APPROVER);

    // `reopen` is final -> review gated by not(actor_not_creator): "only the creator" if it
    // worked, but it would pass an unidentified actor. Nobody gets through it.
    expect(await conditionNotMet(act(id, notRuleId, CREATOR))).toBe(true);
    expect(await conditionNotMet(act(id, notRuleId, BYSTANDER))).toBe(true);
    expect(await conditionNotMet(act(id, notRuleId, undefined))).toBe(true);
  });
});

describe("fail closed", () => {
  it("refuses an unidentified actor (automation, system) on a rule that needs one", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    expect(await conditionNotMet(act(id, approveId, undefined))).toBe(true);
  });

  it("leaves a transition with no actor rule exactly as before", async () => {
    const id = await newInstance();

    // `submit` has no conditions: the creator, or nobody identified, may take it.
    expect((await act(id, submitId, CREATOR)).toState).toBe("review");
    const other = await newInstance();
    expect((await act(other, submitId, undefined)).toState).toBe("review");
  });
});

describe("getAvailableTransitions agrees with the guard", () => {
  async function offered(instanceId: string, actor: string): Promise<string[]> {
    const list = await withTenantContext(TENANT, (tx) =>
      getAvailableTransitions(tx, TENANT, instanceId, ["agent"], actor),
    );
    return list.map((t) => t.label ?? "");
  }

  it("hides a transition the actor would be refused, and shows it to someone allowed", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    expect(await offered(id, CREATOR)).not.toContain("approve");
    expect(await offered(id, SUBMITTER)).not.toContain("approve");
    expect(await offered(id, APPROVER)).toContain("approve");
  });

  it("offers nothing that needs an actor when none is given", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    const list = await withTenantContext(TENANT, (tx) =>
      getAvailableTransitions(tx, TENANT, id, ["agent"]),
    );
    expect(list.map((t) => t.label)).not.toContain("approve");
  });
});

describe("tenant isolation", () => {
  it("another tenant cannot run a rule against this tenant's instance", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER);

    await expect(
      act(id, approveId, APPROVER, OTHER_TENANT),
    ).rejects.toBeInstanceOf(WorkflowError);
    // Nothing moved.
    const [row] = await db
      .select({ state: entityInstances.currentState })
      .from(entityInstances)
      .where(eq(entityInstances.id, id));
    expect(row?.state).toBe("review");
  });
});

describe("a rule's `states` must name real steps, and a named step is protected", () => {
  const caller = { userId: "u-775-admin", isGlobalAdmin: true };

  async function codeOf(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (err) {
      return err instanceof WorkflowError ? err.code : "OTHER";
    }
  }

  it("rejects a rule naming a step the workflow does not have, on create and on update", async () => {
    // A typo would match no event, so the rule would block nobody: it must not be storable.
    expect(
      await codeOf(
        withTenantContext(TENANT, (tx) =>
          addWorkflowTransition(tx, TENANT, workflowId, caller, {
            fromState: "draft",
            toState: "review",
            conditions: { op: "actor_not_prior_actor", states: ["aproval"] },
          }),
        ),
      ),
    ).toBe("WORKFLOW_CONDITION_STATE_UNKNOWN");

    expect(
      await codeOf(
        withTenantContext(TENANT, (tx) =>
          updateWorkflowTransition(tx, TENANT, workflowId, closeId, caller, {
            conditions: {
              op: "actor_not_prior_actor",
              states: ["review", "nope"],
            },
          }),
        ),
      ),
    ).toBe("WORKFLOW_CONDITION_STATE_UNKNOWN");
  });

  it("accepts a rule naming real steps, including inside and/or", async () => {
    const updated = await withTenantContext(TENANT, (tx) =>
      updateWorkflowTransition(tx, TENANT, workflowId, closeId, caller, {
        conditions: {
          op: "and",
          children: [
            { op: "actor_not_prior_actor", states: ["review", "draft"] },
          ],
        },
      }),
    );
    expect(updated.conditions).toBeTruthy();
    // Put the original rule back for the other tests.
    await withTenantContext(TENANT, (tx) =>
      updateWorkflowTransition(tx, TENANT, workflowId, closeId, caller, {
        conditions: { op: "actor_not_prior_actor", states: ["review"] },
      }),
    );
  });

  it("refuses to rename a step a rule names (past events keep the old name)", async () => {
    const [review] = await db
      .select({ id: workflowStates.id })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId));
    const states = await db
      .select({ id: workflowStates.id, name: workflowStates.name })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId));
    const reviewId =
      states.find((x) => x.name === "review")?.id ?? review?.id ?? "";

    expect(
      await codeOf(
        withTenantContext(TENANT, (tx) =>
          updateWorkflowState(tx, TENANT, workflowId, reviewId, caller, {
            name: "in_review",
          }),
        ),
      ),
    ).toBe("WORKFLOW_STATE_IN_USE");
    // Still named "review".
    const after = await db
      .select({ name: workflowStates.name })
      .from(workflowStates)
      .where(eq(workflowStates.id, reviewId));
    expect(after[0]?.name).toBe("review");
  });

  it("refuses to delete a step a rule names, even one no transition touches", async () => {
    const orphan = await withTenantContext(TENANT, (tx) =>
      addWorkflowState(tx, TENANT, workflowId, caller, {
        name: "orphan",
        label: "Orphan",
      }),
    );
    await withTenantContext(TENANT, (tx) =>
      updateWorkflowTransition(tx, TENANT, workflowId, closeId, caller, {
        conditions: {
          op: "actor_not_prior_actor",
          states: ["review", "orphan"],
        },
      }),
    );

    expect(
      await codeOf(
        withTenantContext(TENANT, (tx) =>
          deleteWorkflowState(tx, TENANT, workflowId, orphan.id, caller),
        ),
      ),
    ).toBe("WORKFLOW_STATE_IN_USE");

    // Drop the rule's reference and the step can go.
    await withTenantContext(TENANT, (tx) =>
      updateWorkflowTransition(tx, TENANT, workflowId, closeId, caller, {
        conditions: { op: "actor_not_prior_actor", states: ["review"] },
      }),
    );
    expect(
      await codeOf(
        withTenantContext(TENANT, (tx) =>
          deleteWorkflowState(tx, TENANT, workflowId, orphan.id, caller),
        ),
      ),
    ).toBeNull();
  });

  it("still lets an unreferenced step be renamed", async () => {
    const states = await db
      .select({ id: workflowStates.id, name: workflowStates.name })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId));
    const finalState = states.find((x) => x.name === "final");
    expect(finalState).toBeTruthy();

    expect(
      await codeOf(
        withTenantContext(TENANT, (tx) =>
          updateWorkflowState(
            tx,
            TENANT,
            workflowId,
            finalState?.id ?? "",
            caller,
            {
              name: "final_approval",
            },
          ),
        ),
      ),
    ).toBeNull();
    // Restore so later describes keep their names.
    await withTenantContext(TENANT, (tx) =>
      updateWorkflowState(
        tx,
        TENANT,
        workflowId,
        finalState?.id ?? "",
        caller,
        {
          name: "final",
        },
      ),
    );
  });
});
