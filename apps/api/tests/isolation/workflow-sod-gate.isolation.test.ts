/**
 * #1132 -- the segregation-of-duties write gate against a real database.
 *
 * The route unit tests mock the query, so they cannot show that the rule lookup is scoped to the
 * workflow being edited, that a caller who does not administer the workflow gets 404 whatever the
 * stored rule state, or that a refused save leaves the graph untouched. This file does.
 *
 * On a workflow where any transition carries an actor rule, only a person admin may add or
 * re-point a transition or change who may take one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { canvasSaveHandler } from "../../src/routes/workflows/canvas.js";
import { createTransitionHandler } from "../../src/routes/workflows/transitions/create-transition.js";
import { updateTransitionHandler } from "../../src/routes/workflows/transitions/update-transition.js";
import { updateWorkflowHandler } from "../../src/routes/workflows/update.js";

const TENANT = "aaaaaaaa-1132-4000-a000-000000000001";
const OWNER = "u-owner";
const STRANGER = "u-stranger";
const RULE = { op: "actor_not_creator" };

const entityTypeIds: string[] = [];
let ruledId: string;
let plainId: string;
let ruledSiblingId: string;
let namedId: string;

async function seedWorkflow(
  name: string,
  createdBy: string,
  transitions: Array<{
    fromState: string;
    toState: string;
    allowedRoles: string[];
    conditions: unknown;
  }>,
  stateNames: string[] = ["open", "closed"],
): Promise<{ id: string; transitionIds: string[] }> {
  // One workflow per entity type per tenant.
  const ts = `${Date.now()}_${entityTypeIds.length}`;
  const [et] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `sod_gate_type_${ts}`,
      plural: `sod_gate_types_${ts}`,
      allowCustomFields: false,
    })
    .returning();
  if (!et) throw new Error("entity type insert failed");
  entityTypeIds.push(et.id);
  const entityTypeId = et.id;
  const [wf] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name,
      initialState: "open",
      createdBy,
    })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  await db.insert(workflowStates).values(
    stateNames.map((n, i) => ({
      tenantId: TENANT,
      workflowId: wf.id,
      name: n,
      label: n,
      sortOrder: i,
    })),
  );
  const rows = await db
    .insert(workflowTransitions)
    .values(
      transitions.map((t) => ({ tenantId: TENANT, workflowId: wf.id, ...t })),
    )
    .returning({ id: workflowTransitions.id });
  return { id: wf.id, transitionIds: rows.map((r) => r.id) };
}

beforeAll(async () => {
  const ruled = await seedWorkflow("SoD ruled", OWNER, [
    {
      fromState: "open",
      toState: "closed",
      allowedRoles: ["agent"],
      conditions: RULE,
    },
    {
      fromState: "closed",
      toState: "open",
      allowedRoles: ["admin"],
      conditions: null,
    },
  ]);
  ruledId = ruled.id;
  ruledSiblingId = ruled.transitionIds[1] ?? "";
  // `review` has only unruled edges, but a rule on open -> closed names it.
  namedId = (
    await seedWorkflow(
      "SoD named step",
      OWNER,
      [
        {
          fromState: "open",
          toState: "review",
          allowedRoles: ["agent"],
          conditions: null,
        },
        {
          fromState: "review",
          toState: "open",
          allowedRoles: ["agent"],
          conditions: null,
        },
        {
          fromState: "open",
          toState: "closed",
          allowedRoles: ["agent"],
          conditions: { op: "actor_not_prior_actor", states: ["review"] },
        },
      ],
      ["open", "review", "closed"],
    )
  ).id;
  plainId = (
    await seedWorkflow("SoD plain", OWNER, [
      {
        fromState: "open",
        toState: "closed",
        allowedRoles: ["agent"],
        conditions: null,
      },
    ])
  ).id;
});

afterAll(async () => {
  for (const id of [ruledId, plainId, namedId]) {
    if (!id) continue;
    await db
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, id));
    await db.delete(workflowStates).where(eq(workflowStates.workflowId, id));
    await db.delete(workflows).where(eq(workflows.id, id));
  }
  for (const id of entityTypeIds) {
    await db.delete(entityTypes).where(eq(entityTypes.id, id));
  }
});

function makeApp(userId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: TENANT,
        userId,
        roles,
        email: "t@example.com",
      });
      await next();
    },
  );
  app.post("/:id/transitions", ...createTransitionHandler);
  app.patch("/:id/transitions/:transitionId", ...updateTransitionHandler);
  app.put("/:id/canvas", ...canvasSaveHandler);
  app.patch("/:id", ...updateWorkflowHandler);
  return app;
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const transitionCount = async (workflowId: string): Promise<number> =>
  (
    await db
      .select({ id: workflowTransitions.id })
      .from(workflowTransitions)
      .where(
        and(
          eq(workflowTransitions.workflowId, workflowId),
          eq(workflowTransitions.tenantId, TENANT),
        ),
      )
  ).length;

describe("the SoD write gate on a workflow that carries an actor rule (#1132)", () => {
  it("refuses a non-admin owner adding a transition on a ruled workflow, and writes nothing", async () => {
    const res = await makeApp(OWNER, ["agent"]).request(
      `/${ruledId}/transitions`,
      json("POST", {
        fromState: "open",
        toState: "closed",
        allowedRoles: ["agent"],
        conditions: null,
      }),
    );
    expect(res.status).toBe(403);
    expect(await transitionCount(ruledId)).toBe(2);
  });

  it("applies the rule per workflow: the same caller can add a transition to another workflow without one", async () => {
    const res = await makeApp(OWNER, ["agent"]).request(
      `/${plainId}/transitions`,
      json("POST", {
        fromState: "closed",
        toState: "open",
        allowedRoles: ["agent"],
        conditions: null,
      }),
    );
    expect(res.status).toBe(201);
    expect(await transitionCount(plainId)).toBe(2);
  });

  it("answers 404, not 403, to a caller who does not administer the ruled workflow", async () => {
    const res = await makeApp(STRANGER, ["agent"]).request(
      `/${ruledId}/transitions`,
      json("POST", {
        fromState: "open",
        toState: "closed",
        allowedRoles: ["agent"],
        conditions: null,
      }),
    );
    expect(res.status).toBe(404);
    expect(await transitionCount(ruledId)).toBe(2);
  });

  it("refuses a non-admin owner widening allowedRoles on an unruled sibling, and leaves the roles", async () => {
    const res = await makeApp(OWNER, ["agent"]).request(
      `/${ruledId}/transitions/${ruledSiblingId}`,
      json("PATCH", { allowedRoles: ["agent"] }),
    );
    expect(res.status).toBe(403);
    const [row] = await db
      .select({ allowedRoles: workflowTransitions.allowedRoles })
      .from(workflowTransitions)
      .where(eq(workflowTransitions.id, ruledSiblingId));
    expect(row?.allowedRoles).toEqual(["admin"]);
  });

  it("refuses a canvas save that adds a step and two unruled transitions around the rule, and leaves the graph", async () => {
    const states = await db
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, ruledId));
    const transitions = await db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, ruledId));
    const asState = (s: (typeof states)[number]) => ({
      id: s.id,
      name: s.name,
      label: s.label,
      color: null,
      isTerminal: false,
      slaHours: null,
      sortOrder: s.sortOrder,
    });
    const asTransition = (t: (typeof transitions)[number]) => ({
      id: t.id,
      fromState: t.fromState,
      toState: t.toState,
      label: t.label ?? "",
      allowedRoles: t.allowedRoles,
      requiresComment: t.requiresComment,
      requiresFields: t.requiresFields,
    });
    const leg = (id: string, fromState: string, toState: string) => ({
      id,
      fromState,
      toState,
      label: "",
      allowedRoles: ["agent"],
      requiresComment: false,
      requiresFields: [],
    });
    const res = await makeApp(OWNER, ["agent"]).request(
      `/${ruledId}/canvas`,
      json("PUT", {
        states: [
          ...states.map(asState),
          {
            id: "__new_s",
            name: "fast_track",
            label: "Fast track",
            color: null,
            isTerminal: false,
            slaHours: null,
            sortOrder: 2,
          },
        ],
        transitions: [
          ...transitions.map(asTransition),
          leg("__new_1", "open", "fast_track"),
          leg("__new_2", "fast_track", "closed"),
        ],
      }),
    );
    expect(res.status).toBe(403);
    expect(await transitionCount(ruledId)).toBe(2);
    const after = await db
      .select({ id: workflowStates.id })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, ruledId));
    expect(after).toHaveLength(2);
  });

  it("lets a person admin widen allowedRoles on the same sibling", async () => {
    const res = await makeApp("u-admin", ["admin"]).request(
      `/${ruledId}/transitions/${ruledSiblingId}`,
      json("PATCH", { allowedRoles: ["agent"] }),
    );
    expect(res.status).toBe(200);
    const [row] = await db
      .select({ allowedRoles: workflowTransitions.allowedRoles })
      .from(workflowTransitions)
      .where(eq(workflowTransitions.id, ruledSiblingId));
    expect(row?.allowedRoles).toEqual(["agent"]);
  });

  describe("the initial step and named steps are part of the rule's graph", () => {
    const initialStateOf = async (id: string): Promise<string | undefined> =>
      (
        await db
          .select({ initialState: workflows.initialState })
          .from(workflows)
          .where(eq(workflows.id, id))
      )[0]?.initialState;

    it("refuses a non-admin owner moving the initial step on a ruled workflow, so new records cannot start past the rule", async () => {
      const res = await makeApp(OWNER, ["agent"]).request(
        `/${ruledId}`,
        json("PATCH", { initialState: "closed" }),
      );
      expect(res.status).toBe(403);
      expect(await initialStateOf(ruledId)).toBe("open");
    });

    it("lets the same caller move the initial step on a workflow with no actor rule", async () => {
      const app = makeApp(OWNER, ["agent"]);
      const moved = await app.request(
        `/${plainId}`,
        json("PATCH", { initialState: "closed" }),
      );
      expect(moved.status).toBe(200);
      expect(await initialStateOf(plainId)).toBe("closed");
      await app.request(`/${plainId}`, json("PATCH", { initialState: "open" }));
    });

    it("treats re-sending the current initial step on a ruled workflow as no change", async () => {
      const res = await makeApp(OWNER, ["agent"]).request(
        `/${ruledId}`,
        json("PATCH", { initialState: "open" }),
      );
      expect(res.status).toBe(200);
    });

    it("answers 404, not 403, to a caller who does not administer the ruled workflow", async () => {
      const res = await makeApp(STRANGER, ["agent"]).request(
        `/${ruledId}`,
        json("PATCH", { initialState: "closed" }),
      );
      expect(res.status).toBe(404);
    });

    it("lets a person admin move the initial step on a ruled workflow", async () => {
      const app = makeApp("u-admin", ["admin"]);
      const moved = await app.request(
        `/${ruledId}`,
        json("PATCH", { initialState: "closed" }),
      );
      expect(moved.status).toBe(200);
      expect(await initialStateOf(ruledId)).toBe("closed");
      await app.request(`/${ruledId}`, json("PATCH", { initialState: "open" }));
    });

    it("refuses a canvas save that deletes a step a rule names, and leaves the graph", async () => {
      const states = await db
        .select()
        .from(workflowStates)
        .where(eq(workflowStates.workflowId, namedId));
      const transitions = await db
        .select()
        .from(workflowTransitions)
        .where(eq(workflowTransitions.workflowId, namedId));
      const keptStates = states.filter((st) => st.name !== "review");
      const keptTransitions = transitions.filter(
        (t) => t.fromState !== "review" && t.toState !== "review",
      );
      const res = await makeApp(OWNER, ["agent"]).request(
        `/${namedId}/canvas`,
        json("PUT", {
          states: keptStates.map((st) => ({
            id: st.id,
            name: st.name,
            label: st.label,
            color: null,
            isTerminal: false,
            slaHours: null,
            sortOrder: st.sortOrder,
          })),
          transitions: keptTransitions.map((t) => ({
            id: t.id,
            fromState: t.fromState,
            toState: t.toState,
            label: t.label ?? "",
            allowedRoles: t.allowedRoles,
            requiresComment: t.requiresComment,
            requiresFields: t.requiresFields,
          })),
        }),
      );
      expect(res.status).toBe(409);
      expect(await transitionCount(namedId)).toBe(3);
      const after = await db
        .select({ id: workflowStates.id })
        .from(workflowStates)
        .where(eq(workflowStates.workflowId, namedId));
      expect(after).toHaveLength(3);
    });
  });
});
