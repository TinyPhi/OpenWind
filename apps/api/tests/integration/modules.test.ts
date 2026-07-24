import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  entityFields,
  workflows,
  workflowStates,
  workflowTransitions,
  automationRules,
  modules,
} from "@platform/db";
import { logger } from "@platform/logger";
import { ModuleService } from "../../src/services/module-service.js";
import { createApp } from "../../src/app.js";

const TEST_TENANT_ID = "00000000-0000-0000-0000-000000000099";

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: Context<{ Variables: { auth: AuthContext } }>,
      next: Next,
    ): Promise<void> => {
      c.set("auth", {
        tenantId: TEST_TENANT_ID,
        userId: "u-test-admin",
        roles: ["admin"],
        email: "admin@test.com",
      });
      await next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (c: Context, next: Next): Promise<void> => {
      await next();
    },
  requireIntrospection:
    () =>
    async (c: Context, next: Next): Promise<void> => {
      await next();
    },
}));

describe("Module System Integration Tests", () => {
  let app: Hono;

  beforeAll(async () => {
    // 1. Create a test tenant
    await db
      .insert(tenants)
      .values({
        id: TEST_TENANT_ID,
        name: "Test Module Tenant",
        slug: "test-module-tenant",
        plan: "standard",
        status: "active",
        config: {},
      })
      .onConflictDoNothing();

    // 2. Instantiate Hono app
    app = createApp();

    // 3. Populate modules registry
    await ModuleService.seedRegistry();
  });

  afterAll(async () => {
    // Clean up test data
    await db
      .delete(automationRules)
      .where(eq(automationRules.tenantId, TEST_TENANT_ID));

    // Delete all workflows for this tenant in FK-safe order
    const allWfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, TEST_TENANT_ID));

    for (const wf of allWfs) {
      await db
        .delete(workflowTransitions)
        .where(eq(workflowTransitions.workflowId, wf.id));
      await db
        .delete(workflowStates)
        .where(eq(workflowStates.workflowId, wf.id));
    }
    await db.delete(workflows).where(eq(workflows.tenantId, TEST_TENANT_ID));

    await db
      .delete(entityFields)
      .where(eq(entityFields.tenantId, TEST_TENANT_ID));
    await db
      .delete(entityTypes)
      .where(eq(entityTypes.tenantId, TEST_TENANT_ID));
    await db.delete(tenants).where(eq(tenants.id, TEST_TENANT_ID));
  });

  it("GET /modules - lists registered modules with installed=false status", async () => {
    const res = await app.request("/modules", { method: "GET" });
    expect(res.status).toBe(200);
    const { data: json } = (await res.json()) as {
      data: { slug: string; installed: boolean }[];
    };
    expect(json.length).toBeGreaterThanOrEqual(1);

    const helpdesk = json.find((m) => m.slug === "helpdesk");
    expect(helpdesk).toBeDefined();
    expect(helpdesk?.installed).toBe(false);
  });

  it("POST /modules/helpdesk/install - successfully installs helpdesk module and runs seed SQL", async () => {
    const res = await app.request("/modules/helpdesk/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const { data: json } = (await res.json()) as {
      data: { slug: string; status: string };
    };
    expect(json.status).toBe("installed");

    // Verify tenant config has 'helpdesk'
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TEST_TENANT_ID))
      .limit(1);
    expect(
      (tenant.config as Record<string, unknown>)["installed_modules"],
    ).toContain("helpdesk");

    // Verify entity types created
    const types = await db
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.tenantId, TEST_TENANT_ID));
    expect(types.map((t) => t.name)).toContain("ticket");
    expect(types.map((t) => t.name)).toContain("comment");
    expect(types.map((t) => t.name)).toContain("article");

    const ticketType = types.find((t) => t.name === "ticket")!;

    // Verify entity fields created
    const fields = await db
      .select()
      .from(entityFields)
      .where(eq(entityFields.tenantId, TEST_TENANT_ID));
    const ticketFields = fields.filter((f) => f.entityTypeId === ticketType.id);
    expect(ticketFields.map((f) => f.name)).toContain("title");
    expect(ticketFields.map((f) => f.name)).toContain("description");
    expect(ticketFields.map((f) => f.name)).toContain("priority");
    expect(ticketFields.map((f) => f.name)).toContain("category");

    // Verify workflow created — name comes from {WORKFLOW_NAME} (the
    // module's registry display name, "Helpdesk"), not a hardcoded literal
    // (issue #171 — 002_workflow.sql used to hardcode "ticket_workflow").
    const wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, TEST_TENANT_ID));
    expect(wfs.map((w) => w.name)).toContain("Helpdesk");
    const wf = wfs.find((w) => w.name === "Helpdesk")!;

    // Verify workflow states created
    const states = await db
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, wf.id));
    expect(states.map((s) => s.name)).toContain("open");
    expect(states.map((s) => s.name)).toContain("in_progress");
    expect(states.map((s) => s.name)).toContain("pending");
    expect(states.map((s) => s.name)).toContain("resolved");

    // Verify workflow transitions created
    const transitions = await db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, wf.id));
    expect(transitions.length).toBe(4);

    // Verify automation rule created
    const rules = await db
      .select()
      .from(automationRules)
      .where(eq(automationRules.tenantId, TEST_TENANT_ID));
    expect(rules.map((r) => r.name)).toContain(
      "Auto-set default priority on ticket creation",
    );
  });

  it("GET /modules - shows helpdesk as installed", async () => {
    const res = await app.request("/modules", { method: "GET" });
    expect(res.status).toBe(200);
    const { data: json } = (await res.json()) as {
      data: { slug: string; installed: boolean }[];
    };
    const helpdesk = json.find((m) => m.slug === "helpdesk");
    expect(helpdesk?.installed).toBe(true);
  });

  it("POST /modules/helpdesk/uninstall - uninstalls helpdesk module, config list updated", async () => {
    const res = await app.request("/modules/helpdesk/uninstall", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const { data: json } = (await res.json()) as {
      data: { slug: string; status: string };
    };
    expect(json.status).toBe("uninstalled");

    // Verify tenant config has 'helpdesk' removed
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TEST_TENANT_ID))
      .limit(1);
    expect(
      (tenant.config as Record<string, unknown>)["installed_modules"],
    ).not.toContain("helpdesk");

    // Verify listing shows not installed
    const listRes = await app.request("/modules", { method: "GET" });
    const { data: listJson } = (await listRes.json()) as {
      data: { slug: string; installed: boolean }[];
    };
    const helpdesk = listJson.find((m) => m.slug === "helpdesk");
    expect(helpdesk?.installed).toBe(false);
  });

  // #171 — reinstalling used to accumulate orphaned "Support Ticket" entity
  // types/workflows every cycle (001_seed.sql had no idempotency guard at
  // all). With that file removed, a full install -> uninstall -> reinstall
  // cycle must produce exactly one entity type per distinct name for the
  // module, not one-per-cycle.
  it("install -> uninstall -> reinstall produces exactly one entity type per distinct name (#171 regression)", async () => {
    await app.request("/modules/helpdesk/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const types = await db
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.tenantId, TEST_TENANT_ID));
    const namesCount = new Map<string, number>();
    for (const t of types) {
      namesCount.set(t.name, (namesCount.get(t.name) ?? 0) + 1);
    }
    for (const [name, count] of namesCount) {
      expect(count, `expected exactly one entity type named "${name}"`).toBe(1);
    }
    expect(types.map((t) => t.name).sort()).toEqual(
      ["article", "comment", "ticket"].sort(),
    );

    const wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, TEST_TENANT_ID));
    expect(wfs).toHaveLength(1);
  });
});

// ── workflowName rename (issue #170) ─────────────────────────────────────────
//
// installModule's rename step resolves "the workflow this module just
// seeded" first by exact name match (workflows.name === the module's
// registry display name), falling back to a module_id -> entity_type_id join
// when nothing matches by name. Before this fix, tender's seed SQL hardcoded
// a literal workflow name instead of using {WORKFLOW_NAME}, so the exact-name
// match never found it and the rename silently no-op'd.

describe("installModule — workflowName rename (issue #170)", () => {
  const TENDER_TENANT_ID = "00000000-0000-0000-0000-000000000170";
  const HELPDESK_TENANT_ID = "00000000-0000-0000-0000-000000000171";
  const AMBIGUOUS_TENANT_ID = "00000000-0000-0000-0000-000000000172";
  const AMBIGUOUS_SLUG = "test-ambiguous-170";

  beforeAll(async () => {
    for (const id of [
      TENDER_TENANT_ID,
      HELPDESK_TENANT_ID,
      AMBIGUOUS_TENANT_ID,
    ]) {
      await db
        .insert(tenants)
        .values({
          id,
          name: `Test Rename Tenant ${id}`,
          slug: `test-rename-tenant-${id}`,
          plan: "standard",
          status: "active",
          config: {},
        })
        .onConflictDoNothing();
    }
    await ModuleService.seedRegistry();
  });

  afterAll(async () => {
    for (const id of [
      TENDER_TENANT_ID,
      HELPDESK_TENANT_ID,
      AMBIGUOUS_TENANT_ID,
    ]) {
      await db.delete(automationRules).where(eq(automationRules.tenantId, id));
      const wfs = await db
        .select()
        .from(workflows)
        .where(eq(workflows.tenantId, id));
      for (const wf of wfs) {
        await db
          .delete(workflowTransitions)
          .where(eq(workflowTransitions.workflowId, wf.id));
        await db
          .delete(workflowStates)
          .where(eq(workflowStates.workflowId, wf.id));
      }
      await db.delete(workflows).where(eq(workflows.tenantId, id));
      await db.delete(entityFields).where(eq(entityFields.tenantId, id));
      await db.delete(entityTypes).where(eq(entityTypes.tenantId, id));
      await db.delete(tenants).where(eq(tenants.id, id));
    }
    await db.delete(modules).where(eq(modules.slug, AMBIGUOUS_SLUG));
  });

  it("renames tender's workflow — regression test, fails without the seed-SQL + fallback fix", async () => {
    await ModuleService.installModule(TENDER_TENANT_ID, "tender", {
      workflowName: "Custom Tender Flow",
    });

    const wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, TENDER_TENANT_ID));
    expect(wfs).toHaveLength(1);
    expect(wfs[0]?.name).toBe("Custom Tender Flow");
  });

  it("still renames helpdesk's workflow via the exact-name fast path — unaffected by the fallback addition", async () => {
    await ModuleService.installModule(HELPDESK_TENANT_ID, "helpdesk", {
      workflowName: "Custom Helpdesk Flow",
    });

    const wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, HELPDESK_TENANT_ID));
    // helpdesk seeds exactly one workflow (001_entity_types.sql/002_workflow.sql's
    // "ticket" pair) since issue #171 removed the vestigial second seed
    // pipeline (001_seed.sql) that used to also seed a "Support Ticket"
    // entity type + workflow. 002_workflow.sql now seeds its name via
    // {WORKFLOW_NAME} (matching #170's convention), so the exact-name match
    // (and therefore the rename) still targets it directly.
    expect(wfs).toHaveLength(1);
    const renamed = wfs.filter((w) => w.name === "Custom Helpdesk Flow");
    expect(renamed).toHaveLength(1);
  });

  it("skips the rename and logs a warning when the fallback resolution is ambiguous, rather than guessing", async () => {
    const warnSpy = vi.spyOn(logger, "warn");

    const [inserted] = await db
      .insert(modules)
      .values({
        slug: AMBIGUOUS_SLUG,
        name: "Test Ambiguous Module",
        version: "0.0.1",
      })
      .onConflictDoNothing()
      .returning();
    // onConflictDoNothing returns [] (not the existing row) on conflict — a
    // stale row from an interrupted prior run would otherwise make this
    // undefined. Fall back to a plain SELECT rather than a confusing
    // non-null-assertion throw.
    const moduleRow =
      inserted ??
      (
        await db
          .select()
          .from(modules)
          .where(eq(modules.slug, AMBIGUOUS_SLUG))
          .limit(1)
      )[0];
    if (!moduleRow) throw new Error("failed to create or find test module");
    const moduleId = moduleRow.id;

    // No seed directory exists for this slug, so installModule's seeding step
    // is skipped entirely (logs its own separate warning) and the rename
    // logic below runs against DB state we control directly — two entity
    // types tagged with the same module_id, each with a workflow, neither
    // named to match the module's display name.
    const [etA] = await db
      .insert(entityTypes)
      .values({
        tenantId: AMBIGUOUS_TENANT_ID,
        name: "ambiguous_a",
        plural: "ambiguous_as",
        moduleId,
        allowCustomFields: true,
      })
      .returning();
    const [etB] = await db
      .insert(entityTypes)
      .values({
        tenantId: AMBIGUOUS_TENANT_ID,
        name: "ambiguous_b",
        plural: "ambiguous_bs",
        moduleId,
        allowCustomFields: true,
      })
      .returning();
    await db.insert(workflows).values([
      {
        tenantId: AMBIGUOUS_TENANT_ID,
        entityTypeId: etA!.id,
        name: "workflow_a",
        initialState: "open",
      },
      {
        tenantId: AMBIGUOUS_TENANT_ID,
        entityTypeId: etB!.id,
        name: "workflow_b",
        initialState: "open",
      },
    ]);

    await ModuleService.installModule(AMBIGUOUS_TENANT_ID, AMBIGUOUS_SLUG, {
      workflowName: "Should Not Apply",
    });

    const wfs = await db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, AMBIGUOUS_TENANT_ID));
    expect(wfs.map((w) => w.name).sort()).toEqual(["workflow_a", "workflow_b"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2 }),
      expect.stringContaining("ambiguous"),
    );

    warnSpy.mockRestore();
  });
});
