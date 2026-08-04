/**
 * Isolation tests for automation-rules routes (#6 fix).
 *
 * These routes previously used the plain `db` client instead of
 * `withTenantContext`. Since automation_rules has RLS requiring the
 * app.tenant_id GUC, this meant the routes were completely broken in
 * production: reads always returned empty/not-found, and creates failed
 * outright with an RLS violation error (confirmed directly against Postgres
 * before writing the fix). These tests prove the routes work at all now, and
 * that tenant isolation holds across all five CRUD operations.
 *
 * Uses a real Postgres database (no mocks). Two isolated tenants (A and B).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { withTenantContext, automationRules } from "@platform/db";
import { createAutomationRule } from "@platform/automation-engine";
import type { AuthContext } from "@platform/auth";
import { getAutomationRuleHandler } from "../../src/routes/automation-rules/get.js";
import { listAutomationRulesHandler } from "../../src/routes/automation-rules/list.js";
import { createAutomationRuleHandler } from "../../src/routes/automation-rules/create.js";
import { updateAutomationRuleHandler } from "../../src/routes/automation-rules/update.js";
import { deleteAutomationRuleHandler } from "../../src/routes/automation-rules/delete.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000041";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000042";

let ruleAId: string;

beforeAll(async () => {
  const ruleA = await withTenantContext(TENANT_A, (tx) =>
    createAutomationRule(tx, TENANT_A, {
      name: "isolation-test-rule-a",
      triggerType: "entity.created",
      triggerConfig: {},
      conditions: null,
      actions: [{ type: "notify", config: { channel: ["email"] } }],
    }),
  );
  ruleAId = ruleA.id;
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(automationRules).where(eq(automationRules.id, ruleAId)),
  );
});

function makeApp(tenantId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  );
  app.get("/", ...listAutomationRulesHandler);
  app.get("/:id", ...getAutomationRuleHandler);
  app.post("/", ...createAutomationRuleHandler);
  app.patch("/:id", ...updateAutomationRuleHandler);
  app.delete("/:id", ...deleteAutomationRuleHandler);
  return app;
}

describe("automation-rules routes work at all now (#6 -- previously broken by RLS)", () => {
  it("GET / returns tenant A's own rule (previously always returned [])", async () => {
    const res = await makeApp(TENANT_A).request("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.some((r) => r.id === ruleAId)).toBe(true);
  });

  it("GET /:id returns tenant A's rule for tenant A", async () => {
    const res = await makeApp(TENANT_A).request(`/${ruleAId}`);
    expect(res.status).toBe(200);
  });

  it("GET /:id returns 404 for tenant B fetching tenant A's rule (cross-tenant)", async () => {
    const res = await makeApp(TENANT_B).request(`/${ruleAId}`);
    expect(res.status).toBe(404);
  });

  it("GET / for tenant B never sees tenant A's rule", async () => {
    const res = await makeApp(TENANT_B).request("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.some((r) => r.id === ruleAId)).toBe(false);
  });

  it("POST / creates a rule that is actually persisted and readable (previously failed with an RLS violation)", async () => {
    const res = await makeApp(TENANT_B).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "isolation-test-rule-b",
        triggerType: "entity.created",
        triggerConfig: {},
        actions: [{ type: "notify", config: { channel: ["email"] } }],
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };

    const [row] = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select()
        .from(automationRules)
        .where(eq(automationRules.id, json.data.id)),
    );
    expect(row).toBeDefined();

    await withTenantContext(TENANT_B, (tx) =>
      tx.delete(automationRules).where(eq(automationRules.id, json.data.id)),
    );
  });

  it("PATCH /:id from tenant B on tenant A's rule returns 404, does not mutate it", async () => {
    const res = await makeApp(TENANT_B).request(`/${ruleAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hijacked" }),
    });
    expect(res.status).toBe(404);

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(automationRules).where(eq(automationRules.id, ruleAId)),
    );
    expect(row?.name).toBe("isolation-test-rule-a");
  });

  it("DELETE /:id from tenant B on tenant A's rule returns 404, does not delete it", async () => {
    const res = await makeApp(TENANT_B).request(`/${ruleAId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(automationRules).where(eq(automationRules.id, ruleAId)),
    );
    expect(row).toBeDefined();
  });

  it("PATCH /:id from tenant A on its own rule succeeds", async () => {
    const res = await makeApp(TENANT_A).request(`/${ruleAId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isEnabled: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { isEnabled: boolean } };
    expect(json.data.isEnabled).toBe(false);
  });

  it("POST / rejects with 400 Bad Request when notify actions have a malicious absolute link", async () => {
    const res = await makeApp(TENANT_A).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "malicious-link-rule",
        triggerType: "entity.created",
        triggerConfig: {},
        actions: [
          {
            type: "notify",
            config: {
              recipientId: "u-aaa",
              payload: {
                title: "Warning",
                body: "Body",
                link: "https://evil.com/phishing",
              },
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOTIFY_LINK_INVALID");
  });

  it("POST / rejects with 400 Bad Request when webhook includePayload is true on entity.created without sendFields", async () => {
    const res = await makeApp(TENANT_A).request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "empty-send-fields-rule",
        triggerType: "entity.created",
        triggerConfig: {},
        actions: [
          {
            type: "webhook",
            config: {
              url: "https://platform.example.com/webhook",
              includePayload: true,
            },
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVALID_EVENT_PAYLOAD");
  });
});
