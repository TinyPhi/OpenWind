/**
 * Drift guard (T10, docs/specs/multi-org-sandbox.md): every module-seeded automation
 * rule's `actions` array must match ActionConfigSchema's discriminated-union shape
 * exactly against packages/automation-engine/src/executor.ts's `runAction` switch.
 * Seed SQL is raw INSERT, not the API route, so it bypasses the Zod validation that
 * create.ts/update.ts apply to API-authored rules -- modules/helpdesk/seed/
 * 003_automation_rules.sql's own header documents a real incident where a wrong
 * action shape (`set-field` instead of `set_field`, flat config instead of nested)
 * shipped silently for every install until #126 found it by hand. This test is the
 * "no automated check for seed SQL" gap that comment calls out, closed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionConfigSchema } from "../../src/routes/automation-rules/schemas.js";

const MODULES_DIR = fileURLToPath(
  new URL("../../../../modules", import.meta.url),
);

function findAutomationRuleSeedFiles(): string[] {
  const files: string[] = [];
  for (const moduleDir of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!moduleDir.isDirectory()) continue;
    const seedDir = join(MODULES_DIR, moduleDir.name, "seed");
    let entries: string[];
    try {
      entries = readdirSync(seedDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".sql") && entry.includes("automation_rules")) {
        files.push(join(seedDir, entry));
      }
    }
  }
  return files;
}

// Extracts every `'[...]'::jsonb` array literal from a seed file -- by convention
// (verified against every existing module-seed file), the only array-shaped jsonb
// literal in an automation_rules seed file is the `actions` column; `trigger_config`
// and `conditions` are always object-shaped (`'{...}'::jsonb`), never arrays.
function extractActionsLiterals(sql: string): string[] {
  const matches = sql.matchAll(/'(\[[\s\S]*?\])'::jsonb/g);
  return Array.from(matches, (m) => m[1]);
}

describe("module-seed automation rule actions coverage guard", () => {
  const seedFiles = findAutomationRuleSeedFiles();

  it("found at least one automation-rule seed file to check (guards against this test silently checking nothing)", () => {
    expect(seedFiles.length).toBeGreaterThan(0);
  });

  it.each(seedFiles.map((f) => [f] as const))(
    "every actions array in %s matches ActionConfigSchema",
    (filePath) => {
      const sql = readFileSync(filePath, "utf8");
      const actionsLiterals = extractActionsLiterals(sql);
      expect(
        actionsLiterals.length,
        `no actions array found in ${filePath} -- extractActionsLiterals' convention assumption may no longer hold`,
      ).toBeGreaterThan(0);

      for (const literal of actionsLiterals) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(literal);
        } catch (err) {
          throw new Error(
            `${filePath}: actions literal is not valid JSON: ${String(err)}\n${literal}`,
          );
        }
        expect(
          Array.isArray(parsed),
          `${filePath}: actions must be an array`,
        ).toBe(true);
        for (const action of parsed as unknown[]) {
          const result = ActionConfigSchema.safeParse(action);
          if (!result.success) {
            throw new Error(
              `${filePath}: action ${JSON.stringify(action)} fails ActionConfigSchema: ${result.error.message}`,
            );
          }
        }
      }
    },
  );
});
