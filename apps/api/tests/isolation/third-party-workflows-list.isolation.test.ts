/**
 * Isolation tests for GET /api/v1/workflows (ADR-012 Phase B, PR B2, spec R5/R8).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). The
 * dual-identity auth middleware itself (requireActingPerson — real Zitadel
 * JWT verification) is unit-tested separately in
 * packages/auth/src/dual-identity.test.ts; here `actingPerson` is set
 * directly via a stub middleware, matching this suite's existing pattern of
 * bypassing real JWT verification for `auth` too — the thing under test is
 * this route's own tenant-visibility + scope + pagination behavior, not
 * token verification.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import { db, tenants, workflows, entityTypes } from "@platform/db";
import { createEntityType } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { listThirdPartyWorkflowsHandler } from "../../src/routes/third-party/workflows.js";

const TENANT = "cccccccc-0000-4000-c000-000000000502";
const OTHER_TENANT = "dddddddd-0000-4000-d000-000000000503";

const workflowIds: string[] = [];
const entityTypeIds: string[] = [];

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "3P Workflows Tenant", slug: `3p-workflows-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "3P Workflows Other Tenant",
      slug: `3p-workflows-other-${OTHER_TENANT}`,
    },
  ]);

  // workflows has a unique (tenant_id, entity_type_id) constraint — one
  // workflow per tenant per entity type — so each fixture workflow below
  // needs its own entity type, not a shared one.
  const suffix = Date.now();
  async function newEntityType(label: string): Promise<string> {
    const et = await createEntityType(db, null, {
      name: `third_party_wf_test_${label}_${suffix}`,
      plural: `third_party_wf_tests_${label}_${suffix}`,
      allowCustomFields: true,
    });
    entityTypeIds.push(et.id);
    return et.id;
  }

  const rows = await db
    .insert(workflows)
    .values([
      {
        tenantId: TENANT,
        entityTypeId: await newEntityType("visible1"),
        name: "3P Visible Workflow 1",
        initialState: "open",
      },
      {
        tenantId: TENANT,
        entityTypeId: await newEntityType("visible2"),
        name: "3P Visible Workflow 2",
        initialState: "open",
      },
      {
        tenantId: TENANT,
        entityTypeId: await newEntityType("inactive"),
        name: "3P Inactive Workflow",
        initialState: "open",
        isActive: false,
      },
      {
        // NULL tenantId = system/template workflow, visible to every tenant
        // (ADR-007) — proves visibleTo(tenantId)'s union branch is honored.
        tenantId: null,
        entityTypeId: await newEntityType("system"),
        name: "3P System Workflow",
        initialState: "open",
      },
      {
        tenantId: OTHER_TENANT,
        entityTypeId: await newEntityType("other-tenant"),
        name: "3P Other Tenant Workflow",
        initialState: "open",
      },
    ])
    .returning({ id: workflows.id });
  workflowIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  await db.delete(workflows).where(inArray(workflows.id, workflowIds));
  await db.delete(entityTypes).where(inArray(entityTypes.id, entityTypeIds));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(auth: AuthContext, actingPerson: ActingPersonContext) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", auth);
    c.set("actingPerson", actingPerson);
    await next();
  });
  app.get("/", ...listThirdPartyWorkflowsHandler);
  return app;
}

const ACTING_PERSON: ActingPersonContext = {
  userId: "person-1",
  email: "person1@example.com",
  displayName: "Person One",
  orgId: "org-ccc",
};

function apiKeyAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "apikey:11111111-1111-1111-1111-111111111111",
    tenantId: TENANT,
    roles: ["entity:ticket:read"],
    email: "",
    displayName: "API Key 11111111",
    orgId: "org-ccc",
    ...overrides,
  };
}

describe("GET /api/v1/workflows", () => {
  it("returns only workflows visible to the key's tenant, active by default", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; name: string; entityTypeId: string }[];
    };
    const names = body.data.map((w) => w.name);
    expect(names).toContain("3P Visible Workflow 1");
    expect(names).toContain("3P Visible Workflow 2");
    expect(names).toContain("3P System Workflow");
    expect(names).not.toContain("3P Inactive Workflow");
    expect(names).not.toContain("3P Other Tenant Workflow");
  });

  it("each returned object contains exactly id, name, entityTypeId — no other fields", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/");
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(
        ["entityTypeId", "id", "name"].sort(),
      );
    }
  });

  it("paginates with limit/offset", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const firstPage = await app.request("/?limit=1&offset=0");
    const firstBody = (await firstPage.json()) as { data: { id: string }[] };
    expect(firstBody.data.length).toBe(1);

    const secondPage = await app.request("/?limit=1&offset=1");
    const secondBody = (await secondPage.json()) as { data: { id: string }[] };
    expect(secondBody.data.length).toBe(1);
    expect(secondBody.data[0]?.id).not.toBe(firstBody.data[0]?.id);
  });

  it("rejects a key without the entity:ticket:read scope", async () => {
    const app = makeApp(
      apiKeyAuth({ roles: ["entity:ticket:create"] }),
      ACTING_PERSON,
    );
    const res = await app.request("/");
    expect(res.status).toBe(403);
  });
});
