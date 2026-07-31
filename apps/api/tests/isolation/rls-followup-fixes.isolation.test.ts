/**
 * Isolation tests for the #10 follow-up audit's five RLS-breakage fixes:
 * admin/audit.ts, api-keys/{create,delete,list}.ts, view-configs/index.ts.
 *
 * Same root cause as #6 (automation-rules): each route used the plain `db`
 * client against an RLS-enabled table instead of `withTenantContext`. Verified
 * directly against Postgres before writing the fix (SELECT/INSERT as app_user
 * with no tenant GUC set): admin_audit_log reads returned 0 rows for a real
 * row, api_keys INSERT failed with an RLS violation, api_keys SELECT/DELETE
 * silently no-op'd, and view_configs reads/writes had the same problem.
 *
 * Uses a real Postgres database (no mocks). requireIntrospection() is part of
 * the api-keys handler chains -- sending a Bearer token with the sk_ prefix
 * short-circuits it (API keys are documented as exempt from introspection),
 * avoiding the need for a live Zitadel connection in this test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  withTenantContext,
  adminAuditLog,
  apiKeys,
  viewConfigs,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { getAuditLogHandler } from "../../src/routes/admin/audit.js";
import { createApiKeyHandler } from "../../src/routes/api-keys/create.js";
import { listApiKeysHandler } from "../../src/routes/api-keys/list.js";
import { deleteApiKeyHandler } from "../../src/routes/api-keys/delete.js";
import { viewConfigsRouter } from "../../src/routes/view-configs/index.js";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000051";

let auditLogId: string;

beforeAll(async () => {
  const [row] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(adminAuditLog)
      .values({
        tenantId: TENANT_A,
        actorId: "isolation-test-actor",
        actorType: "user",
        action: "created",
        resourceType: "test_resource",
        resourceId: crypto.randomUUID(),
      })
      .returning({ id: adminAuditLog.id }),
  );
  auditLogId = row?.id ?? "";
});

// admin_audit_log is intentionally append-only (no DELETE grant for
// app_user) -- there is nothing to clean up here by design.

function makeApp(handlers: unknown[], route = "/") {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get(route, ...(handlers as any));
  return app;
}

function skHeaders() {
  return { Authorization: "Bearer sk_isolation_test_bypass" };
}

describe("GET /admin/audit (#10 fix)", () => {
  it("returns the real audit log entry (previously always returned [])", async () => {
    const app = makeApp(getAuditLogHandler);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.some((e) => e.id === auditLogId)).toBe(true);
  });
});

describe("api-keys CRUD (#10 fix)", () => {
  let createdKeyId: string | undefined;

  it("POST /api-keys creates a key (previously failed with an RLS violation)", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    });
    app.post("/", ...createApiKeyHandler);

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...skHeaders() },
      body: JSON.stringify({ name: "isolation-test-key", scopes: ["agent"] }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { id: string } };
    createdKeyId = json.data.id;
  });

  it("GET /api-keys lists the created key (previously always returned [])", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    });
    app.get("/", ...listApiKeysHandler);

    const res = await app.request("/", { headers: skHeaders() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { id: string }[] };
    expect(json.data.some((k) => k.id === createdKeyId)).toBe(true);
  });

  it("DELETE /api-keys/:id deletes the key (previously always 404'd)", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    });
    app.delete("/:id", ...deleteApiKeyHandler);

    const res = await app.request(`/${createdKeyId}`, {
      method: "DELETE",
      headers: skHeaders(),
    });
    expect(res.status).toBe(204);

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, createdKeyId ?? "")),
    );
    expect(row).toBeUndefined();
  });
});

describe("view-configs GET/PATCH (#10 fix)", () => {
  const ENTITY_TYPE = "isolation-test-entity";

  afterAll(async () => {
    await withTenantContext(TENANT_A, (tx) =>
      tx.delete(viewConfigs).where(eq(viewConfigs.entityTypeSlug, ENTITY_TYPE)),
    );
  });

  it("GET returns 404 before any config exists (previously would 500 or always-404 for the wrong reason)", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    });
    app.route("/", viewConfigsRouter);

    const res = await app.request(`/${ENTITY_TYPE}`);
    expect(res.status).toBe(404);
  });

  it("PATCH creates a new config (201), then GET returns it (previously the SELECT/INSERT pair was invisible under RLS)", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    });
    app.route("/", viewConfigsRouter);

    const patchRes = await app.request(`/${ENTITY_TYPE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listColumns: [{ field: "title" }] }),
    });
    expect(patchRes.status).toBe(201);

    const getRes = await app.request(`/${ENTITY_TYPE}`);
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as {
      data: { listColumns: { field: string }[] };
    };
    expect(json.data.listColumns[0]?.field).toBe("title");
  });

  it("a second PATCH updates the existing config (200, not another 201)", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        tenantId: TENANT_A,
        userId: "isolation-test-user",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    });
    app.route("/", viewConfigsRouter);

    const res = await app.request(`/${ENTITY_TYPE}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listColumns: [{ field: "updated" }] }),
    });
    expect(res.status).toBe(200);
  });
});
