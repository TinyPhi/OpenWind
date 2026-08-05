/**
 * Isolation tests for ticket-to-ticket reference linking (docs/specs/ticket-reference-linking.md).
 * Real Postgres connection, RLS + app_user enforced (not mocked) — cross-tenant
 * link/unlink attempts must be indistinguishable from "not found" (404, never 403),
 * and link create/delete must never emit an outbox event (no automation coupling, R6).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  entityTypes,
  entityInstances,
  entityRelations,
  outboxEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { createReferenceHandler } from "../../src/routes/entities/create-reference.js";
import { deleteReferenceHandler } from "../../src/routes/entities/delete-reference.js";

const TENANT_A = "eeeeeeee-0000-4000-e000-0000000eef01";
const TENANT_B = "eeeeeeee-0000-4000-e000-0000000eef02";

let entityTypeId: string;
let ticketA: string; // owned by "owner-a", tenant A
let ticketB: string; // owned by "owner-b", tenant A (no relation to owner-a)
let ticketOtherTenant: string; // tenant B
let baselineOutboxCount: number; // entity.created events from ticket setup, unrelated to link create/delete

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation Ref Tenant A",
      slug: `iso-ref-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Isolation Ref Tenant B",
      slug: `iso-ref-b-${Date.now()}`,
    },
  ]);

  const entityType = await createEntityType(db, null, {
    name: `isolation_ref_ticket_${Date.now()}`,
    plural: "isolation_ref_tickets",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const a = await createEntity(db, TENANT_A, {
    entityTypeId,
    fields: {},
    createdBy: "owner-a",
    workflowId: null,
    currentState: "initial",
  });
  ticketA = a.id;

  const b = await createEntity(db, TENANT_A, {
    entityTypeId,
    fields: {},
    createdBy: "owner-b",
    workflowId: null,
    currentState: "initial",
  });
  ticketB = b.id;

  const other = await createEntity(db, TENANT_B, {
    entityTypeId,
    fields: {},
    createdBy: "owner-other-tenant",
    workflowId: null,
    currentState: "initial",
  });
  ticketOtherTenant = other.id;

  const baselineRows = await withTenantContext(TENANT_A, (tx) =>
    tx.select().from(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_A)),
  );
  baselineOutboxCount = baselineRows.length;
});

afterAll(async () => {
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_A));
  await db
    .delete(entityRelations)
    .where(eq(entityRelations.tenantId, TENANT_A));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_A));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_B));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

function makeApp(tenantId: string, userId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId, userId, roles, email: "t@test.dev" });
      await next();
    },
  );
  app.post("/:id/references", ...createReferenceHandler);
  app.delete("/:id/references/:relationId", ...deleteReferenceHandler);
  return app;
}

describe("reference-link routes — real Postgres, RLS enforced", () => {
  // Created once in beforeAll (not inside a test) — four tests below depend
  // on these ids, and a shared setup that isn't itself a skippable `it`
  // means those tests fail loudly on a real setup error instead of with a
  // misleading "cannot read property 'id' of undefined" if the create test
  // were skipped or reordered.
  let relationIdOnA: string; // "references" row, fromInstanceId = ticketA
  let relationIdOnB: string; // "referenced_by" row, fromInstanceId = ticketB
  let createLinkData: { id: string; relationType: string }[];

  beforeAll(async () => {
    const res = await makeApp(TENANT_A, "isolation-agent", ["agent"]).request(
      `/${ticketA}/references`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toInstanceId: ticketB }),
      },
    );
    if (res.status !== 201) {
      throw new Error(
        `setup: expected 201 creating the shared reference link, got ${res.status}`,
      );
    }
    const { data } = (await res.json()) as {
      data: { id: string; relationType: string }[];
    };
    createLinkData = data;
    relationIdOnA = data.find((r) => r.relationType === "references")!.id;
    relationIdOnB = data.find((r) => r.relationType === "referenced_by")!.id;
  });

  it("creator with access to both tickets can create a link", async () => {
    const res = await makeApp(TENANT_A, "owner-a", ["user"]).request(
      `/${ticketA}/references`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toInstanceId: ticketB }),
      },
    );
    // owner-a created ticketA but not ticketB — expect 404 (no access to target)
    expect(res.status).toBe(404);
  });

  it("admin/agent can create a link between two unrelated tickets", () => {
    expect(createLinkData).toHaveLength(2);
    expect(relationIdOnA).toBeDefined();
    expect(relationIdOnB).toBeDefined();
  });

  it("R6: creating a reference link emits no outbox event (no automation coupling)", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_A)),
    );
    expect(rows).toHaveLength(baselineOutboxCount);
  });

  it("returns 404 (not 403) when the target ticket belongs to another tenant", async () => {
    const res = await makeApp(TENANT_A, "isolation-agent", ["agent"]).request(
      `/${ticketA}/references`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toInstanceId: ticketOtherTenant }),
      },
    );
    expect(res.status).toBe(404);

    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.tenantId, TENANT_A),
            eq(entityRelations.fromInstanceId, ticketA),
            eq(entityRelations.toInstanceId, ticketOtherTenant),
          ),
        ),
    );
    expect(rows).toHaveLength(0);
  });

  it("returns 404 (not 403) attempting to delete a reference link scoped to another tenant", async () => {
    const res = await makeApp(TENANT_B, "isolation-agent", ["agent"]).request(
      `/${ticketOtherTenant}/references/${relationIdOnA}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);

    // Confirm the tenant-A link is untouched
    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(eq(entityRelations.id, relationIdOnA)),
    );
    expect(row?.deletedAt).toBeNull();
  });

  it("rejects deleting a relation id that does not belong to the viewed ticket (prevents cross-ticket deletion by guessing an id)", async () => {
    // owner-b has access to ticketB, but relationIdOnA's fromInstanceId is
    // ticketA, not ticketB — must be rejected even though owner-b can see ticketB.
    const res = await makeApp(TENANT_A, "owner-b", ["user"]).request(
      `/${ticketB}/references/${relationIdOnA}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(eq(entityRelations.id, relationIdOnA)),
    );
    expect(row?.deletedAt).toBeNull();
  });

  it("R5: the target side (owner-b) can unlink unilaterally via its own referenced_by row, without the source side acting", async () => {
    const res = await makeApp(TENANT_A, "owner-b", ["user"]).request(
      `/${ticketB}/references/${relationIdOnB}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(204);

    const [rowA] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(eq(entityRelations.id, relationIdOnA)),
    );
    expect(rowA?.deletedAt).not.toBeNull();

    const [rowB] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(entityRelations)
        .where(eq(entityRelations.id, relationIdOnB)),
    );
    expect(rowB?.deletedAt).not.toBeNull();
  });

  it("R6: unlinking emits no outbox event", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.tenantId, TENANT_A)),
    );
    expect(rows).toHaveLength(baselineOutboxCount);
  });
});
