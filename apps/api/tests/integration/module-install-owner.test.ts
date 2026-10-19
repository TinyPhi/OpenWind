import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, tenants, entityTypes, modules, workflows } from "@platform/db";
import { ModuleService } from "../../src/services/module-service.js";

// docs/specs/mandatory-ticket-fields.md R7: installing a module records the installer as the
// owner of its seeded workflows, so a ticket that names nobody has someone to fall back to.
// Only where no owner is set. Runs on its own fresh tenant.

const TENANT_ID = randomUUID();

async function ownerOf(slug: string): Promise<string | null | undefined> {
  const [mod] = await db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.slug, slug))
    .limit(1);
  const [row] = await db
    .select({ createdBy: workflows.createdBy })
    .from(workflows)
    .innerJoin(entityTypes, eq(entityTypes.id, workflows.entityTypeId))
    .where(
      and(eq(workflows.tenantId, TENANT_ID), eq(entityTypes.moduleId, mod!.id)),
    )
    .limit(1);
  return row?.createdBy;
}

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT_ID,
    name: "Module install owner",
    slug: `module-install-owner-${TENANT_ID}`,
    config: {},
  });
  await ModuleService.seedRegistry();
});

afterAll(async () => {
  for (const table of [
    "automation_rules",
    "view_configs",
    "workflow_transitions",
    "workflow_states",
    "workflows",
    "entity_fields",
    "entity_types",
  ]) {
    await db
      .execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${TENANT_ID}::uuid`,
      )
      .catch(() => undefined);
  }
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_ID]));
});

describe("ModuleService.installModule — workflow owner", () => {
  it("records the installer as the owner of the module's workflows", async () => {
    await ModuleService.installModule(TENANT_ID, "helpdesk", {
      installedBy: "u-installer",
    });
    expect(await ownerOf("helpdesk")).toBe("u-installer");
  });

  it("leaves another module's existing owner alone", async () => {
    await ModuleService.installModule(TENANT_ID, "crm", {
      installedBy: "u-someone-else",
    });
    expect(await ownerOf("crm")).toBe("u-someone-else");
    expect(await ownerOf("helpdesk")).toBe("u-installer");
  });

  it("sets no owner when nobody is named", async () => {
    await ModuleService.installModule(TENANT_ID, "projects");
    expect(await ownerOf("projects")).toBeNull();
  });
});
