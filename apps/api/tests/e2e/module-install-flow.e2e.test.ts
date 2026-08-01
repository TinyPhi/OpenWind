/**
 * e2e MVP (#194): proves the harness genuinely works — real HTTP through the
 * full app (`createApp()`), real Postgres, and (the key difference from every
 * existing "integration" test in this repo, which all mock `@platform/auth`
 * entirely) real, unmocked auth: a real API key row, hashed and looked up via
 * `resolve_api_key_by_hash` exactly like a live client would authenticate.
 *
 * Flow: install the helpdesk module for a fresh tenant, then fetch its seeded
 * view config — both over real HTTP, both through the real requireAuth/
 * requireRole middleware chain, no mocks anywhere in the request path.
 *
 * `entities`/`workflows` routes require a real Zitadel JWT (requireAuth() with
 * no db argument — API keys are intentionally rejected there), so this flow
 * uses the `modules`/`view-configs` routes instead, which do support API-key
 * auth (`requireAuth(db)`) — the same real auth mechanism, without needing a
 * live Zitadel container for this first e2e test. Covering the ~93-endpoint
 * API surface, including the JWT-only routes, is deliberately out of scope
 * here and left for incremental follow-up.
 *
 * Requires docker compose services: Postgres, Redis.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  tenants,
  apiKeys,
  viewConfigs,
  entityTypes,
  entityFields,
  workflows,
  workflowStates,
  workflowTransitions,
  automationRules,
} from "@platform/db";
import { hashApiKey } from "@platform/auth";
import { createApp } from "../../src/app.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000194";
const RAW_API_KEY = "sk_e2e_test_194_" + Math.random().toString(36).slice(2);

const app = createApp();

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT_ID,
    name: "e2e MVP tenant (#194)",
    slug: `e2e-mvp-194-${Date.now()}`,
  });

  await db.insert(apiKeys).values({
    tenantId: TENANT_ID,
    name: "e2e MVP key",
    keyHash: hashApiKey(RAW_API_KEY),
    scopes: ["admin"],
  });
});

afterAll(async () => {
  // Module install seeds workflows/workflow_states/workflow_transitions and
  // automation_rules alongside entity_types/entity_fields - delete in FK
  // dependency order (children before parents) rather than assuming only
  // the two tables this test directly asserts on were created.
  const tenantWorkflows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.tenantId, TENANT_ID));
  const workflowIds = tenantWorkflows.map((w) => w.id);
  if (workflowIds.length > 0) {
    await db
      .delete(workflowTransitions)
      .where(inArray(workflowTransitions.workflowId, workflowIds));
    await db
      .delete(workflowStates)
      .where(inArray(workflowStates.workflowId, workflowIds));
  }
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT_ID));
  await db
    .delete(automationRules)
    .where(eq(automationRules.tenantId, TENANT_ID));
  await db.delete(viewConfigs).where(eq(viewConfigs.tenantId, TENANT_ID));
  await db.delete(entityFields).where(eq(entityFields.tenantId, TENANT_ID));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_ID));
  await db.delete(apiKeys).where(eq(apiKeys.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${RAW_API_KEY}`,
    "Content-Type": "application/json",
  };
}

describe("e2e: module install -> seeded view config (real HTTP, real auth)", () => {
  it("GET /admin/view-configs/ticket returns 404 before the module is installed", async () => {
    const res = await app.request("/admin/view-configs/ticket", {
      method: "GET",
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("rejects the request with 401 when no API key is presented", async () => {
    const res = await app.request("/modules/helpdesk/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("POST /modules/helpdesk/install seeds the module, then GET returns real view config data", async () => {
    const installRes = await app.request("/modules/helpdesk/install", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(installRes.status).toBe(201);

    const getRes = await app.request("/admin/view-configs/ticket", {
      method: "GET",
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);

    const { data } = (await getRes.json()) as {
      data: {
        entityTypeSlug: string;
        formFieldOrder: string[];
        listColumns: unknown[];
      };
    };
    expect(data.entityTypeSlug).toBe("ticket");
    expect(data.formFieldOrder).toContain("title");
    expect(data.listColumns.length).toBeGreaterThan(0);
  });
});
