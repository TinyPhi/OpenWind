/**
 * Isolation tests for GET /api/v1/workflows/:workflowId/fields
 * (docs/specs/third-party-api-workflow-fields-schema.md).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import { db, tenants, entityFields } from "@platform/db";
import { createEntityType, addEntityField } from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import { createWorkflow } from "@platform/workflow-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { getThirdPartyWorkflowFieldsHandler } from "../../src/routes/third-party/workflow-fields.js";
import { createThirdPartyTicketHandler } from "../../src/routes/third-party/tickets.js";

const TENANT = "ffffffff-0000-4000-f000-000000000f01";
const OTHER_TENANT = "ffffffff-0000-4000-f000-000000000f02";

let entityType: EntityType;
let workflowId: string;
let emptyEntityType: EntityType;
let emptyWorkflowId: string;
let otherTenantWorkflowId: string;

const ACTING_PERSON = "third-party-workflow-fields-actor";

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "3P Fields Tenant", slug: `3p-fields-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "3P Fields Other Tenant",
      slug: `3p-fields-other-${OTHER_TENANT}`,
    },
  ]);

  // Global entity type (tenantId null) so a tenant-specific field can be
  // layered on top -- proves the response unions both, per spec R1.
  entityType = await createEntityType(db, null, {
    name: `third_party_fields_test_${Date.now()}`,
    plural: "third_party_fields_tests",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `third_party_fields_workflow_${Date.now()}`,
    initialState: "open",
  });
  workflowId = workflow.id;

  // A global field (tenantId null) -- inserted directly since
  // addEntityField always stamps the calling tenant, with no way to create
  // a global field through it.
  await db.insert(entityFields).values({
    entityTypeId: entityType.id,
    tenantId: null,
    name: "title",
    label: "Title",
    fieldType: "text",
    config: {},
    isRequired: true,
    isIndexed: false,
    isSystem: true,
    sortOrder: 0,
    sensitivity: "public",
  });

  // A tenant-specific, sensitive, optional field with a higher sortOrder --
  // proves both the global+tenant union (R1) and that isSystem has no
  // bearing on inclusion (R3) once combined with the field above.
  await addEntityField(db, TENANT, entityType.id, {
    name: "amount",
    label: "Amount",
    fieldType: "currency",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 1,
    sensitivity: "financial",
  });

  // A workflow whose entity type has zero custom fields.
  emptyEntityType = await createEntityType(db, null, {
    name: `third_party_fields_empty_test_${Date.now()}`,
    plural: "third_party_fields_empty_tests",
    allowCustomFields: true,
  });
  const emptyWorkflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: emptyEntityType.id,
    name: `third_party_fields_empty_workflow_${Date.now()}`,
    initialState: "open",
  });
  emptyWorkflowId = emptyWorkflow.id;

  // A workflow belonging to a different tenant, to prove cross-tenant 404.
  const otherEntityType = await createEntityType(db, null, {
    name: `third_party_fields_other_test_${Date.now()}`,
    plural: "third_party_fields_other_tests",
    allowCustomFields: true,
  });
  const otherWorkflow = await createWorkflow(db, OTHER_TENANT, "test-actor", {
    entityTypeId: otherEntityType.id,
    name: `third_party_fields_other_workflow_${Date.now()}`,
    initialState: "open",
  });
  otherTenantWorkflowId = otherWorkflow.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(scopes: string[] = ["entity:ticket:read"]) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "apikey:77777777-7777-4777-7777-777777777777",
      tenantId: TENANT,
      roles: scopes,
      email: "",
      displayName: "API Key 77777777",
      orgId: "org-fff",
    });
    c.set("actingPerson", {
      userId: ACTING_PERSON,
      email: `${ACTING_PERSON}@example.com`,
      displayName: ACTING_PERSON,
      orgId: "org-fff",
    });
    await next();
  });
  app.get(
    "/workflows/:workflowId/fields",
    ...getThirdPartyWorkflowFieldsHandler,
  );
  app.post("/tickets", ...createThirdPartyTicketHandler);
  return app;
}

async function getFields(app: Hono<Vars>, id: string) {
  return app.request(`/workflows/${id}/fields`, { method: "GET" });
}

describe("GET /api/v1/workflows/:workflowId/fields", () => {
  it("returns the full field schema, unioning global + tenant-specific fields, ordered by sortOrder", async () => {
    const app = makeApp();
    const res = await getFields(app, workflowId);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        workflowId: string;
        entityTypeId: string;
        fields: Array<{
          name: string;
          label: string;
          type: string;
          required: boolean;
          sensitivity: string;
          config: Record<string, unknown>;
        }>;
      };
    };

    expect(body.data.workflowId).toBe(workflowId);
    expect(body.data.entityTypeId).toBe(entityType.id);
    expect(body.data.fields).toHaveLength(2);

    // sortOrder 0 first (global "title"), then sortOrder 1 ("amount")
    expect(body.data.fields[0]).toEqual({
      name: "title",
      label: "Title",
      type: "text",
      required: true,
      sensitivity: "public",
      config: {},
    });
    expect(body.data.fields[1]).toEqual({
      name: "amount",
      label: "Amount",
      type: "currency",
      required: false,
      sensitivity: "financial",
      config: {},
    });
  });

  it("includes an isSystem field identically to a non-system field (isSystem has no bearing on inclusion)", async () => {
    const app = makeApp();
    const res = await getFields(app, workflowId);
    const body = (await res.json()) as {
      data: { fields: Array<{ name: string }> };
    };

    // "title" is isSystem:true in the fixture above and still appears,
    // with no `isSystem` key at all in the wire shape (spec R3 -- the field
    // is surfaced, the internal admin-edit-protection flag is not).
    const titleField = body.data.fields.find((f) => f.name === "title");
    expect(titleField).toBeDefined();
    expect(titleField).not.toHaveProperty("isSystem");
  });

  it("returns an empty array for a workflow whose entity type has no custom fields", async () => {
    const app = makeApp();
    const res = await getFields(app, emptyWorkflowId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fields: unknown[] } };
    expect(body.data.fields).toEqual([]);
  });

  it("field names are wire-compatible with POST /tickets's 422 VALIDATION_ERROR field names", async () => {
    const app = makeApp(["entity:ticket:read", "entity:ticket:create"]);
    const schemaRes = await getFields(app, workflowId);
    const schemaBody = (await schemaRes.json()) as {
      data: { fields: Array<{ name: string; required: boolean }> };
    };
    const requiredNames = schemaBody.data.fields
      .filter((f) => f.required)
      .map((f) => f.name)
      .sort();

    const createRes = await app.request("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflowId, fields: {} }),
    });
    expect(createRes.status).toBe(422);
    const createBody = (await createRes.json()) as {
      fields: Array<{ field: string }>;
    };
    const missingNames = createBody.fields.map((f) => f.field).sort();

    expect(missingNames).toEqual(requiredNames);
  });

  it("returns 404 for a nonexistent workflow id", async () => {
    const app = makeApp();
    const res = await getFields(app, "00000000-0000-4000-a000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "NOT_FOUND", message: "Record not found" });
  });

  it("returns the identical 404 for a workflow belonging to a different tenant", async () => {
    const app = makeApp();
    const res = await getFields(app, otherTenantWorkflowId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("rejects a key without the entity:ticket:read scope", async () => {
    const app = makeApp(["entity:ticket:create"]);
    const res = await getFields(app, workflowId);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("FORBIDDEN");
  });

  it("rejects a request whose auth userId does not start with apikey: (invalid token)", async () => {
    const app = new Hono<Vars>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        userId: "user-jwt-token-id-12345",
        tenantId: TENANT,
        roles: ["entity:ticket:read"],
        email: "",
        displayName: "User",
        orgId: "org-fff",
      });
      c.set("actingPerson", {
        userId: ACTING_PERSON,
        email: `${ACTING_PERSON}@example.com`,
        displayName: ACTING_PERSON,
        orgId: "org-fff",
      });
      await next();
    });
    app.get(
      "/workflows/:workflowId/fields",
      ...getThirdPartyWorkflowFieldsHandler,
    );

    const res = await getFields(app, workflowId);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.message).toBe("Invalid token");
  });

  it("sets the standard per-key-and-person rate-limit headers on a successful response", async () => {
    const app = makeApp();
    const res = await getFields(app, workflowId);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-key-person-limit")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-key-person-remaining")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-key-person-reset")).not.toBeNull();
  });
});
