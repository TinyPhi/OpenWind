import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Owner decision 2026-10-19 (docs/specs/mandatory-ticket-fields.md): a team assignment
// resolves to the on-call person on every workflow, so the seeded resolve_oncall rules
// carry no entity-type scope.
const SEED = fileURLToPath(
  new URL(
    "../../../../modules/helpdesk/seed/003_automation_rules.sql",
    import.meta.url,
  ),
);

describe("helpdesk seed: on-call assignment rules", () => {
  const inserts = readFileSync(SEED, "utf8")
    .split("INSERT INTO automation_rules")
    .slice(1)
    .filter((block) => block.includes('"resolve_oncall"'));

  it("seeds the created and the updated rule", () => {
    expect(inserts).toHaveLength(2);
  });

  it("scopes neither rule to an entity type", () => {
    for (const block of inserts) {
      expect(block).toContain("'{}'::jsonb,");
      expect(block).not.toContain("entityType");
    }
  });
});
