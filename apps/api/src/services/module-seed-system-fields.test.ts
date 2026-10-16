import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// docs/specs/mandatory-ticket-fields.md R1/R2. is_system=true means protected (can't be
// renamed, made optional or deleted -- ADR-004 CF-01); it never hides a field. Every
// workflow's title is protected and required. Any other protected field is listed here
// deliberately.
const ALLOWED_SYSTEM_FIELDS = new Set([
  // ADR-016 D3 + the helpdesk seed's own business fields.
  "helpdesk/ticket.description",
  "helpdesk/ticket.priority",
  "helpdesk/ticket.category",
  "helpdesk/ticket.severity",
  "helpdesk/ticket.department",
  "helpdesk/article.body",
  "helpdesk/article.category",
  "helpdesk/comment.body",
  "helpdesk/comment.ticket_id",
  // Engine-written; also config.readOnly (checked below).
  "tender/tender.submitted_at",
  "tender/tender.submitted_by",
]);

// Not workflows: comments render in their own panel and have no title.
const TYPES_WITHOUT_TITLE = new Set(["helpdesk/comment"]);

const READ_ONLY_FIELDS = [
  "tender/tender.submitted_at",
  "tender/tender.submitted_by",
];

const MODULES_DIR = fileURLToPath(
  new URL("../../../../modules", import.meta.url),
);

interface SeedFieldRow {
  module: string;
  entityType: string;
  field: string;
  isRequired: boolean;
  isSystem: boolean;
  config: string;
}

// Splits at top-level commas, keeping quoted strings and parenthesised groups whole.
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuote) {
      current += ch;
      if (ch === "'") {
        if (text.charAt(i + 1) === "'") {
          current += "'";
          i++;
        } else {
          inQuote = false;
        }
      }
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function stripComments(sql: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql.charAt(i);
    if (!inQuote && ch === "-" && sql.charAt(i + 1) === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "'") inQuote = !inQuote;
    out += ch;
  }
  return out;
}

function parseSeedFieldRows(module: string, sql: string): SeedFieldRow[] {
  const rows: SeedFieldRow[] = [];
  const insert =
    /INSERT INTO entity_fields\s*\(([^)]*)\)\s*VALUES([\s\S]*?)(?:ON CONFLICT|;)/gi;
  for (const match of stripComments(sql).matchAll(insert)) {
    const columns = (match[1] ?? "").split(",").map((c) => c.trim());
    const col = (name: string): number => columns.indexOf(name);
    for (const tuple of splitTopLevel(match[2] ?? "")) {
      const values = splitTopLevel(tuple.replace(/^\(|\)$/g, ""));
      const value = (name: string): string => values[col(name)] ?? "";
      const entityType = /name\s*=\s*'([^']+)'/.exec(
        value("entity_type_id"),
      )?.[1];
      const field = /^'([^']+)'$/.exec(value("name"))?.[1];
      if (!entityType || !field) {
        throw new Error(`unparsed entity_fields row in ${module}: ${tuple}`);
      }
      rows.push({
        module,
        entityType,
        field,
        isRequired: value("is_required").toLowerCase() === "true",
        isSystem: value("is_system").toLowerCase() === "true",
        config: value("config"),
      });
    }
  }
  return rows;
}

function allSeedFieldRows(): SeedFieldRow[] {
  return readdirSync(MODULES_DIR).flatMap((module) => {
    const seedDir = join(MODULES_DIR, module, "seed");
    if (!existsSync(seedDir)) return [];
    return readdirSync(seedDir)
      .filter((f) => f.endsWith(".sql"))
      .flatMap((f) =>
        parseSeedFieldRows(module, readFileSync(join(seedDir, f), "utf8")),
      );
  });
}

describe("module seeds — mandatory title and protected fields", () => {
  const rows = allSeedFieldRows();
  const key = (r: SeedFieldRow): string =>
    `${r.module}/${r.entityType}.${r.field}`;
  const typeKey = (r: SeedFieldRow): string => `${r.module}/${r.entityType}`;

  it("parses the seeded fields (guards against a vacuous pass)", () => {
    expect(rows.length).toBeGreaterThan(40);
    expect(new Set(rows.map(typeKey)).size).toBeGreaterThanOrEqual(10);
  });

  it("gives every workflow entity type a required, protected title", () => {
    const types = [...new Set(rows.map(typeKey))].filter(
      (t) => !TYPES_WITHOUT_TITLE.has(t),
    );
    const missing = types.filter(
      (t) =>
        !rows.some(
          (r) =>
            typeKey(r) === t &&
            r.field === "title" &&
            r.isRequired &&
            r.isSystem,
        ),
    );
    expect(missing).toEqual([]);
  });

  it("protects only titles and the listed fields", () => {
    const unexpected = rows
      .filter((r) => r.isSystem && r.field !== "title")
      .map(key)
      .filter((k) => !ALLOWED_SYSTEM_FIELDS.has(k));
    expect(unexpected).toEqual([]);
  });

  it("marks engine-written fields read-only", () => {
    const notReadOnly = READ_ONLY_FIELDS.filter((k) => {
      const row = rows.find((r) => key(r) === k);
      return !row || !/"readOnly"\s*:\s*true/.test(row.config);
    });
    expect(notReadOnly).toEqual([]);
  });
});
