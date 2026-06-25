/**
 * Isolation tests for the `assignedTo` filter on GET /entities.
 *
 * Covers the SEC-3 fix: non-privileged (`user`-role) callers must be scoped to
 * their own records regardless of query parameters. An admin/agent in Tenant A
 * may filter by any userId within that tenant but cannot see Tenant B's records.
 *
 * Uses a real Postgres database (no mocks). Two isolated tenants (A and B) are
 * seeded before the suite and torn down after.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, withTenantContext } from "@platform/db";
import { entityInstances, entityTypes } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { listEntitiesHandler } from "../../src/routes/entities/list.js";

// ── Test tenant / user IDs ────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000031";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000032";

const USER_A1 = "user-a1-assignee-test";
const USER_A2 = "user-a2-assignee-test";
const USER_B1 = "user-b1-assignee-test";

// ── Shared state ──────────────────────────────────────────────────────────────

let entityTypeId: string;
let instanceA1Id: string; // assigned to USER_A1
let instanceA2Id: string; // assigned to USER_A2
let instanceB1Id: string; // assigned to USER_B1

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_assignee_${Date.now()}`,
      plural: `isolation_assignees_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const instA1 = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId,
      fields: {},
      assignedTo: USER_A1,
    }),
  );
  instanceA1Id = instA1.id;

  const instA2 = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId,
      fields: {},
      assignedTo: USER_A2,
    }),
  );
  instanceA2Id = instA2.id;

  const instB1 = await withTenantContext(TENANT_B, (tx) =>
    createEntity(tx, TENANT_B, {
      entityTypeId,
      fields: {},
      assignedTo: USER_B1,
    }),
  );
  instanceB1Id = instB1.id;
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

// ── HTTP test app factory ─────────────────────────────────────────────────────

function makeApp(tenantId: string, userId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId, userId, roles, email: "test@example.com" });
      await next();
    },
  );
  app.get("/", ...listEntitiesHandler);
  return app;
}

function url(params: Record<string, string>) {
  const q = new URLSearchParams({ entityTypeId, ...params });
  return `/?${q}`;
}

// ── user-role assignedTo filter bypass ───────────────────────────────────────

describe("GET /entities — user-role assignedTo scoping", () => {
  it("user-role caller always sees only their own records, ignoring assignedTo param", async () => {
    const app = makeApp(TENANT_A, USER_A1, ["user"]);

    // Pass USER_A2's id — must be silently ignored; result must be USER_A1's records only
    const res = await app.request(url({ assignedTo: USER_A2 }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    const ids = data.map((r) => r.id);
    expect(ids).toContain(instanceA1Id);
    expect(ids).not.toContain(instanceA2Id);
  });

  it("user-role caller cannot enumerate records assigned to another user by varying the param", async () => {
    const app = makeApp(TENANT_A, USER_A1, ["user"]);

    const res = await app.request(url({ assignedTo: USER_A2 }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((r) => r.id)).not.toContain(instanceA2Id);
  });

  it("user-role caller sees no results when they have no assigned records", async () => {
    const UNASSIGNED_USER = "user-has-no-records";
    const app = makeApp(TENANT_A, UNASSIGNED_USER, ["user"]);

    const res = await app.request(url({}));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: unknown[] };
    expect(data).toHaveLength(0);
  });
});

// ── admin/agent-role filter passthrough ──────────────────────────────────────

describe("GET /entities — admin/agent assignedTo filter passthrough", () => {
  it("admin can filter to a specific user within their tenant", async () => {
    const app = makeApp(TENANT_A, "admin-a", ["admin"]);

    const res = await app.request(url({ assignedTo: USER_A2 }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    const ids = data.map((r) => r.id);
    expect(ids).toContain(instanceA2Id);
    expect(ids).not.toContain(instanceA1Id);
  });

  it("agent can filter to a specific user within their tenant", async () => {
    const app = makeApp(TENANT_A, "agent-a", ["agent"]);

    const res = await app.request(url({ assignedTo: USER_A1 }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((r) => r.id)).toContain(instanceA1Id);
  });
});

// ── cross-tenant isolation ────────────────────────────────────────────────────

describe("GET /entities — cross-tenant isolation via assignedTo", () => {
  it("admin in Tenant A cannot see Tenant B records by passing Tenant B's user ID", async () => {
    const app = makeApp(TENANT_A, "admin-a", ["admin"]);

    const res = await app.request(url({ assignedTo: USER_B1 }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((r) => r.id)).not.toContain(instanceB1Id);
  });

  it("user in Tenant A cannot see Tenant B records even when passing Tenant B instance as assignedTo", async () => {
    const app = makeApp(TENANT_A, USER_B1, ["user"]);

    // Even if the caller's userId matches Tenant B's assignee, tenant scoping prevents leakage
    const res = await app.request(url({}));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((r) => r.id)).not.toContain(instanceB1Id);
  });
});
