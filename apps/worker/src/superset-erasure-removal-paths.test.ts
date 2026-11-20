import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * ADR-019 criterion 16 (#1140, review S2): every path that removes a user or deletes an account is
 * listed in docs/runbooks/superset-erasure.md ("Enumeration of user-removal paths") with whether it
 * runs the Superset erasure or why it cannot leave an account behind. That list is a snapshot, so
 * this is a tripwire on the files that mention the removal primitives: a new one fails here until
 * someone decides whether it needs the Superset erasure, updates the runbook list, and then this set.
 *
 * It matches the identifier, not a call, so an aliased import, a method call, a function reference
 * and a re-export all count. It is still best-effort: a new wrapper function added to a file that is
 * already listed, and called from another new file through that wrapper, is not tracked.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN_DIRS = ["apps", "packages", "scripts", "modules"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    )
      out.push(full);
  }
  return out;
}

/** The source without whole-line comments, which mention these names in prose. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

function mentionsIdentifier(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(code(source));
}

function deletesTenantUsers(source: string): boolean {
  const text = code(source);
  return (
    /\.delete\(\s*(?:schema\.)?tenantUsers\s*,?\s*\)/.test(text) ||
    /delete\s+from\s+tenant_users/i.test(text)
  );
}

function filesWhere(pattern: (source: string) => boolean): string[] {
  return SCAN_DIRS.map((d) => join(ROOT, d))
    .filter(existsSync)
    .flatMap(sourceFiles)
    .filter((f) => pattern(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f))
    .sort();
}

describe("the scanner", () => {
  it("counts an import, an alias, a method call and a reference, and ignores comments", () => {
    const real = [
      'import { deleteOrg as rm } from "@platform/auth";',
      "await auth.deleteOrg(id);",
      "ids.map(deleteOrg);",
    ];
    for (const line of real)
      expect(mentionsIdentifier(line, "deleteOrg")).toBe(true);
    expect(
      mentionsIdentifier(
        "// deleteOrg() is not guaranteed\n * deleteOrg()",
        "deleteOrg",
      ),
    ).toBe(false);
    expect(mentionsIdentifier("const deleteOrgs = 1;", "deleteOrg")).toBe(
      false,
    );
  });

  it("finds a tenant_users delete in each spelling", () => {
    expect(deletesTenantUsers("await tx.delete(tenantUsers).where(x);")).toBe(
      true,
    );
    expect(deletesTenantUsers("await tx.delete(schema.tenantUsers)")).toBe(
      true,
    );
    expect(
      deletesTenantUsers("await tx\n  .delete(\n    tenantUsers,\n  )"),
    ).toBe(true);
    expect(deletesTenantUsers("sql`DELETE FROM tenant_users WHERE x`")).toBe(
      true,
    );
    expect(deletesTenantUsers("// await tx.delete(tenantUsers)")).toBe(false);
  });
});

describe("user-removal sites match the runbook list (#1140 criterion 16)", () => {
  it("deleteUser: the per-user erasure route, plus the definition and its two re-exports", () => {
    expect(filesWhere((s) => mentionsIdentifier(s, "deleteUser"))).toEqual([
      "apps/api/src/lib/zitadel-management.ts",
      "apps/api/src/routes/platform/users.ts",
      "packages/auth/src/index.ts",
      "packages/auth/src/zitadel-management.ts",
    ]);
  });

  it("deleteOrg: sandbox delete and the provisioning rollback, plus the definition and re-export", () => {
    expect(filesWhere((s) => mentionsIdentifier(s, "deleteOrg"))).toEqual([
      "apps/worker/src/sandbox-delete-worker.ts",
      "apps/worker/src/sandbox-provisioning-worker.ts",
      "packages/auth/src/index.ts",
      "packages/auth/src/zitadel-management.ts",
    ]);
  });

  it("tenant_users rows are deleted only by the per-user erasure and the tenant purge", () => {
    expect(filesWhere(deletesTenantUsers)).toEqual([
      "apps/api/src/services/user-erasure.ts",
      "apps/worker/src/tenant-purge.ts",
    ]);
  });
});
