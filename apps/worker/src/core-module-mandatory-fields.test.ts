/**
 * Mandatory-field rule (2026-10-14): in every core-module workflow, `title` is the only
 * required custom field. Due date, assignee, remark and severity are built-in ticket columns
 * (required at the API layer), and every other custom field is optional, which puts it in the
 * create form's Others tab. Sandboxes and real tenants both get these entity types straight
 * from modules/<slug>/seed/*.sql, so this reads those files rather than a database.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// ADR-005 category = 'core' -- the set every tenant (and every sandbox) gets.
const CORE_MODULES = [
  "crm",
  "helpdesk",
  "hrms",
  "invoicing",
  "procurement",
  "projects",
  "reimbursements",
];

const MODULES_DIR = join(__dirname, "..", "..", "..", "modules");

function moduleSql(slug: string): string {
  const dir = join(MODULES_DIR, slug, "seed");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

const ENTITY = String.raw`\(SELECT id FROM entity_types WHERE name = '([^']+)' AND tenant_id = '\{TENANT_ID\}'\)`;

function workflowEntityTypes(sql: string): string[] {
  const re = new RegExp(
    String.raw`INSERT INTO workflows[^;]*?SELECT gen_random_uuid\(\), '\{TENANT_ID\}', ${ENTITY}`,
    "g",
  );
  return [...sql.matchAll(re)].map((m) => m[1] ?? "");
}

/** Every entity_fields row: (entityType, field, isRequired). Handles both row shapes the
 * seeds use -- is_required straight after field_type, or after a config literal. */
function fieldRows(
  sql: string,
): { entityType: string; field: string; required: boolean }[] {
  const re = new RegExp(
    String.raw`${ENTITY}, '\{TENANT_ID\}', '([a-z_]+)',\s*'[^']*',\s*'[a-z_]+',\s*(?:'[^']*'::jsonb,\s*)?(true|false)`,
    "g",
  );
  return [...sql.matchAll(re)].map((m) => ({
    entityType: m[1] ?? "",
    field: m[2] ?? "",
    required: m[3] === "true",
  }));
}

describe("core-module workflows follow the mandatory-field rule", () => {
  it.each(CORE_MODULES)("%s", (slug) => {
    const sql = moduleSql(slug);
    const workflowTypes = workflowEntityTypes(sql);
    expect(workflowTypes.length, `${slug} defines no workflow`).toBeGreaterThan(
      0,
    );

    const rows = fieldRows(sql);
    for (const entityType of workflowTypes) {
      const fields = rows.filter((r) => r.entityType === entityType);
      expect(
        fields.find((f) => f.field === "title")?.required,
        `${slug}/${entityType} needs a required title field`,
      ).toBe(true);
      expect(
        fields
          .filter((f) => f.required && f.field !== "title")
          .map((f) => f.field),
        `${slug}/${entityType}: only title may be required -- move the rest to Others`,
      ).toEqual([]);
    }
  });
});
