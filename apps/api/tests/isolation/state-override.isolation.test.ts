/**
 * Guarded state override (docs/specs/state-override.md).
 *
 * Real Postgres; every engine call goes through withTenantContext, so RLS is active as
 * app_user. Workflow: draft -> review (SLA 4h) -> final (SLA 8h) -> done, plus an approve rule
 * on review -> final that a person who already acted cannot take.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  entityInstances,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
  outboxEvents,
} from "@platform/db";
import {
  executeTransition,
  overrideWorkflowState,
  WorkflowError,
} from "@platform/workflow-engine";

const TENANT = "ffffffff-0776-4000-a000-000000000001";
const OTHER_TENANT = "ffffffff-0776-4000-b000-000000000002";

const CREATOR = "u-776-creator";
const SUBMITTER = "u-776-submitter";
const ADMIN = "u-776-admin";

let entityTypeId: string;
let workflowId: string;
let otherWorkflowId: string;
let submitId: string;
let approveId: string;
const instanceIds: string[] = [];

async function newInstance(
  opts: { tenantId?: string; createdBy?: string } = {},
) {
  const tenantId = opts.tenantId ?? TENANT;
  const [row] = await db
    .insert(entityInstances)
    .values({
      tenantId,
      entityTypeId,
      workflowId: tenantId === TENANT ? workflowId : otherWorkflowId,
      currentState: "draft",
      fields: {},
      createdBy: opts.createdBy ?? CREATOR,
    })
    .returning({ id: entityInstances.id });
  if (!row) throw new Error("instance insert failed");
  instanceIds.push(row.id);
  return row.id;
}

async function setSwitch(on: boolean): Promise<void> {
  await db
    .update(workflows)
    .set({ allowStateOverride: on })
    .where(eq(workflows.id, workflowId));
}

function override(
  instanceId: string,
  over: Partial<{
    state: string;
    reason: string;
    actorId: string;
    actorRoles: string[];
    tenantId: string;
  }> = {},
) {
  const tenantId = over.tenantId ?? TENANT;
  return withTenantContext(tenantId, (tx) =>
    overrideWorkflowState(tx, tenantId, {
      instanceId,
      state: over.state ?? "final",
      reason: over.reason ?? "Customer escalated; skipping review",
      actorId: over.actorId ?? ADMIN,
      actorRoles: over.actorRoles ?? ["admin"],
    }),
  );
}

async function code(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof WorkflowError ? err.code : "OTHER";
  }
}

function act(instanceId: string, transitionId: string, actorId: string) {
  return withTenantContext(TENANT, (tx) =>
    executeTransition(tx, TENANT, {
      instanceId,
      transitionId,
      actorId,
      actorRoles: ["agent"],
    }),
  );
}

async function outboxFor(instanceId: string, eventType: string) {
  const rows = await db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.tenantId, TENANT),
        eq(outboxEvents.eventType, eventType),
      ),
    );
  return rows.filter(
    (r) => (r.payload as { instanceId?: string }).instanceId === instanceId,
  );
}

async function stateOf(instanceId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ s: entityInstances.currentState })
    .from(entityInstances)
    .where(eq(entityInstances.id, instanceId));
  return row?.s;
}

beforeAll(async () => {
  const ts = Date.now();
  const [et] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_ovr_${ts}`,
      plural: `isolation_ovrs_${ts}`,
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
        name: "Override workflow",
        initialState: "draft",
        allowStateOverride: tenantId === OTHER_TENANT,
      })
      .returning({ id: workflows.id });
    if (!wf) throw new Error("workflow insert failed");
    if (tenantId === TENANT) workflowId = wf.id;
    else otherWorkflowId = wf.id;

    await db.insert(workflowStates).values(
      [
        ["draft", null],
        ["review", 4],
        ["final", 8],
        ["done", null],
      ].map(([name, sla], i) => ({
        tenantId,
        workflowId: wf.id,
        name: name as string,
        label: name as string,
        isTerminal: name === "done",
        slaHours: sla as number | null,
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
          conditions: { op: "actor_not_prior_actor" },
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
  await db
    .delete(outboxEvents)
    .where(inArray(outboxEvents.tenantId, [TENANT, OTHER_TENANT]));
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

describe("the switch", () => {
  it("is off by default and refuses an override while off", async () => {
    await setSwitch(false);
    const id = await newInstance();

    expect(await code(override(id))).toBe("OVERRIDE_NOT_ENABLED");
    expect(await stateOf(id)).toBe("draft");
  });
});

describe("a permitted override", () => {
  beforeAll(async () => setSwitch(true));

  it("moves the record, skipping steps, and records who, why and from where", async () => {
    const id = await newInstance();

    const event = await override(id, {
      state: "final",
      reason: "  Customer escalated; skipping review  ",
    });

    expect(await stateOf(id)).toBe("final");
    expect(event).toMatchObject({
      instanceId: id,
      fromState: "draft",
      toState: "final",
      actorId: ADMIN,
      triggeredBy: "user",
      comment: "Override: Customer escalated; skipping review",
      metadata: {
        kind: "override",
        reason: "Customer escalated; skipping review",
      },
    });
    const [row] = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.id, event.id));
    // A real state change: this is what makes it count as acting.
    expect(row?.fromState).not.toBe(row?.toState);
  });

  it("emits the outbox event with override:true, like a transition, so automations still see it", async () => {
    const id = await newInstance();
    await override(id, { state: "review" });

    const events = await outboxFor(id, "workflow.transitioned");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      fromState: "draft",
      toState: "review",
      actorId: ADMIN,
      override: true,
    });
  });

  it("moves the SLA timers: cancels the one for the step it leaves, schedules the one it enters", async () => {
    const id = await newInstance();
    await act(id, submitId, SUBMITTER); // enters review: SLA 4h scheduled
    const before = await outboxFor(id, "workflow.sla_scheduled");
    expect(before).toHaveLength(1);
    expect(before[0]?.deliveredAt).toBeNull();

    await override(id, { state: "final" }); // leaves review, enters final (SLA 8h)

    const after = await outboxFor(id, "workflow.sla_scheduled");
    const review = after.find(
      (r) => (r.payload as { stateName?: string }).stateName === "review",
    );
    const final = after.find(
      (r) => (r.payload as { stateName?: string }).stateName === "final",
    );
    expect(review?.deliveredAt).not.toBeNull(); // cancelled
    expect(final).toBeTruthy();
    expect(final?.deliveredAt).toBeNull(); // pending
  });

  it("counts as acting: an admin who overrode a step cannot then approve it", async () => {
    const id = await newInstance();
    await override(id, { state: "review" }); // ADMIN left draft

    const refused = await withTenantContext(TENANT, (tx) =>
      executeTransition(tx, TENANT, {
        instanceId: id,
        transitionId: approveId,
        actorId: ADMIN,
        actorRoles: ["admin"],
      }),
    ).then(
      () => null,
      (e: unknown) => (e instanceof WorkflowError ? e.code : "OTHER"),
    );
    expect(refused).toBe("CONDITION_NOT_MET");
    // Someone else can.
    expect((await act(id, approveId, SUBMITTER)).toState).toBe("final");
  });
});

describe("who may override", () => {
  beforeAll(async () => setSwitch(true));

  it("refuses a non-admin", async () => {
    const id = await newInstance();
    expect(await code(override(id, { actorRoles: ["agent"] }))).toBe(
      "OVERRIDE_FORBIDDEN",
    );
    expect(await code(override(id, { actorRoles: [] }))).toBe(
      "OVERRIDE_FORBIDDEN",
    );
    expect(await stateOf(id)).toBe("draft");
  });

  it.each(["apikey:5d1c7e0a-0000-4000-8000-000000000001", "system", ""])(
    "refuses an API-key, system or empty identity (%j) even with the admin role",
    async (actorId) => {
      const id = await newInstance();
      expect(await code(override(id, { actorId }))).toBe("OVERRIDE_FORBIDDEN");
      expect(await stateOf(id)).toBe("draft");
    },
  );

  it("refuses the person who created the record, even an admin", async () => {
    const id = await newInstance({ createdBy: ADMIN });
    expect(await code(override(id, { actorId: ADMIN }))).toBe(
      "OVERRIDE_FORBIDDEN",
    );
    expect(await stateOf(id)).toBe("draft");
  });
});

describe("what it checks", () => {
  beforeAll(async () => setSwitch(true));

  it.each(["", "   ", "too short", "x".repeat(1001)])(
    "refuses a missing, blank, too short or too long reason (%#)",
    async (reason) => {
      const id = await newInstance();
      expect(await code(override(id, { reason }))).toBe(
        "OVERRIDE_REASON_REQUIRED",
      );
      expect(await stateOf(id)).toBe("draft");
    },
  );

  it("refuses a step the workflow does not have, and the step it is already in", async () => {
    const id = await newInstance();
    expect(await code(override(id, { state: "nowhere" }))).toBe(
      "WORKFLOW_STATE_NOT_FOUND",
    );
    expect(await code(override(id, { state: "draft" }))).toBe(
      "OVERRIDE_NO_CHANGE",
    );
    expect(await stateOf(id)).toBe("draft");
  });

  it("writes nothing when it is refused", async () => {
    const id = await newInstance();
    await code(override(id, { reason: "short" }));
    await code(override(id, { actorRoles: ["agent"] }));

    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.instanceId, id));
    expect(events).toHaveLength(0);
    expect(await outboxFor(id, "workflow.transitioned")).toHaveLength(0);
  });
});

describe("tenant isolation", () => {
  it("another tenant's admin cannot override this tenant's record (even with their own switch on)", async () => {
    await setSwitch(true);
    const id = await newInstance();

    const result = await code(override(id, { tenantId: OTHER_TENANT }));

    expect(result).toBe("INSTANCE_NOT_FOUND");
    expect(await stateOf(id)).toBe("draft");
  });

  it("this tenant's switch does not enable overrides on another tenant's workflow", async () => {
    await setSwitch(false);
    const otherId = await newInstance({ tenantId: OTHER_TENANT });
    // The other tenant's own switch is on, so its admin can; ours being off changes nothing there.
    expect(
      (await override(otherId, { tenantId: OTHER_TENANT, state: "review" }))
        .toState,
    ).toBe("review");
    const ours = await newInstance();
    expect(await code(override(ours))).toBe("OVERRIDE_NOT_ENABLED");
  });
});
