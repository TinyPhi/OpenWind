/**
 * Isolation test for ADR-012 Phase G, spec R7 — PII redaction wired into
 * the third-party ticket-detail read route (workflows.ts's read route
 * returns only a static id/name/entityTypeId allowlist with no field
 * content, confirmed by direct read — nothing to redact there).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  entityFields,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { getThirdPartyTicketHandler } from "../../src/routes/third-party/tickets.js";

const TENANT = "eeff0011-0000-4000-e000-000000000f01";
const CREATOR = "read-redaction-creator";

let ticketId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Read Redaction Tenant",
    slug: `read-redaction-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `read_redaction_test_${Date.now()}`,
    plural: "read_redaction_tests",
    allowCustomFields: true,
  });

  await db.insert(entityFields).values([
    {
      entityTypeId: entityType.id,
      tenantId: TENANT,
      name: "ssn",
      label: "SSN",
      fieldType: "text",
      sensitivity: "pii",
      isRequired: false,
      isIndexed: false,
      isSystem: false,
      sortOrder: 0,
    },
    {
      entityTypeId: entityType.id,
      tenantId: TENANT,
      name: "subject",
      label: "Subject",
      fieldType: "text",
      sensitivity: "internal",
      isRequired: false,
      isIndexed: false,
      isSystem: false,
      sortOrder: 1,
    },
  ]);

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId: entityType.id,
      name: "Read Redaction Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });

  await db.insert(workflowStates).values({
    tenantId: TENANT,
    workflowId: workflow!.id,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });

  const ticket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: { ssn: "123-45-6789", subject: "Non-sensitive subject" },
    createdBy: CREATOR,
    workflowId: workflow!.id,
    currentState: "open",
  });
  ticketId = ticket.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp() {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "apikey:33333333-3333-4333-3333-333333333333",
      tenantId: TENANT,
      roles: ["entity:ticket:read"],
      email: "",
      displayName: "API Key",
      orgId: "org-redaction",
    });
    c.set("actingPerson", {
      userId: CREATOR,
      email: `${CREATOR}@example.com`,
      displayName: CREATOR,
      orgId: "org-redaction",
    });
    await next();
  });
  app.get("/tickets/:id", ...getThirdPartyTicketHandler);
  return app;
}

describe("Phase G, spec R7 — third-party ticket-detail redaction", () => {
  it("redacts a pii-sensitivity field but passes through a non-sensitive field unchanged", async () => {
    const app = makeApp();
    const res = await app.request(`/tickets/${ticketId}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { fields: Record<string, unknown> };
    };
    expect(body.data.fields["ssn"]).not.toBe("123-45-6789");
    expect(body.data.fields["subject"]).toBe("Non-sensitive subject");
  });
});
