/**
 * Guards on the generic relation route (POST /entities/:id/relations).
 *
 * Engine-owned relation types (parent_of/child_of, references/referenced_by)
 * are created only through their own routes, which enforce one-parent, depth
 * and cycle rules and access on both ends. The generic route must refuse them,
 * and a caller who cannot read the target must get exactly the response a
 * missing target gets, so the route is not an existence oracle.
 *
 * Real Postgres, RLS enforced.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  entityRelations,
  outboxEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { createRelationHandler } from "../../src/routes/entities/create-relation.js";

const TENANT_A = "eeeeeeee-0000-4000-e000-00000000c9a1";
const TENANT_B = "eeeeeeee-0000-4000-e000-00000000c9b2";
const MISSING_ID = "eeeeeeee-0000-4000-e000-00000000dead";

let entityTypeId: string;
let mine: string; // tenant A, created by owner-a
let mine2: string; // tenant A, created by owner-a
let theirs: string; // tenant A, created by owner-b (owner-a has no access)
let otherTenant: string; // tenant B

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Relation Guards A",
      slug: `rel-guard-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Relation Guards B",
      slug: `rel-guard-b-${Date.now()}`,
    },
  ]);
  const et = await createEntityType(db, null, {
    name: `relation_guard_ticket_${Date.now()}`,
    plural: "relation_guard_tickets",
    allowCustomFields: true,
  });
  entityTypeId = et.id;
  const make = async (tenantId: string, createdBy: string): Promise<string> =>
    (
      await createEntity(db, tenantId, {
        entityTypeId,
        fields: {},
        createdBy,
        workflowId: null,
        currentState: "initial",
      })
    ).id;
  mine = await make(TENANT_A, "owner-a");
  mine2 = await make(TENANT_A, "owner-a");
  theirs = await make(TENANT_A, "owner-b");
  otherTenant = await make(TENANT_B, "owner-other");
});

afterAll(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, t));
    await db.delete(entityRelations).where(eq(entityRelations.tenantId, t));
    await db.delete(entityInstances).where(eq(entityInstances.tenantId, t));
  }
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

function post(
  userId: string,
  roles: string[],
  fromId: string,
  body: { toInstanceId: string; relationType: string },
): Promise<Response> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId: TENANT_A, userId, roles, email: "t@test.dev" });
      await next();
    },
  );
  app.post("/:id/relations", ...createRelationHandler);
  return app.request(`/${fromId}/relations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const NOT_FOUND_BODY = {
  error: "RELATION_TARGET_NOT_FOUND",
  message: "Not found",
};

describe("POST /entities/:id/relations guards", () => {
  it("refuses engine-owned relation types, whatever their case or padding", async () => {
    for (const relationType of [
      "child_of",
      "parent_of",
      "references",
      "referenced_by",
      "  Child_Of ",
    ]) {
      const res = await post("owner-a", ["user"], mine, {
        toInstanceId: mine2,
        relationType,
      });
      expect(res.status).toBe(422);
    }
    // Refused for admins too: the engine rules apply to everyone.
    const res = await post("admin-x", ["admin"], mine, {
      toInstanceId: theirs,
      relationType: "child_of",
    });
    expect(res.status).toBe(422);
  });

  it("answers a target the caller cannot read exactly like a missing target", async () => {
    const noAccess = await post("owner-a", ["user"], mine, {
      toInstanceId: theirs,
      relationType: "relates_to",
    });
    const missing = await post("owner-a", ["user"], mine, {
      toInstanceId: MISSING_ID,
      relationType: "relates_to",
    });
    const crossTenant = await post("owner-a", ["user"], mine, {
      toInstanceId: otherTenant,
      relationType: "relates_to",
    });
    for (const res of [noAccess, missing, crossTenant]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND_BODY);
    }
  });

  it("still links two tickets the caller can read", async () => {
    const res = await post("owner-a", ["user"], mine, {
      toInstanceId: mine2,
      relationType: "relates_to",
    });
    expect(res.status).toBe(201);
  });

  it("keeps tenant-wide linking for agents, but never across tenants", async () => {
    const inTenant = await post("agent-x", ["agent"], mine, {
      toInstanceId: theirs,
      relationType: "blocks",
    });
    expect(inTenant.status).toBe(201);
    const cross = await post("agent-x", ["agent"], mine, {
      toInstanceId: otherTenant,
      relationType: "blocks",
    });
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual(NOT_FOUND_BODY);
  });
});
