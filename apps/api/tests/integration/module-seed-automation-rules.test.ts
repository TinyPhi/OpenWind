/**
 * Drift guard (T10, docs/specs/multi-org-sandbox.md & #827): every module-seeded automation
 * rule's `actions`, `trigger_config`, and `conditions` must match their authoritative schemas:
 * - `trigger_type`: matches TriggerTypeSchema (valid, active trigger types only).
 * - `trigger_config`: matches TRIGGER_CONFIG_SCHEMAS per trigger type (enforces strict keys).
 * - `conditions`: matches ConditionTreeSchema (recursive operators & operand structure).
 * - `actions`: matches ActionConfigSchema's discriminated-union shape.
 *
 * Seed SQL is raw INSERT, not the API route, so it bypasses the Zod validation that
 * create.ts/update.ts apply to API-authored rules. Real past incidents:
 * - modules/helpdesk: wrong action shape (`set-field` instead of `set_field`, #126).
 * - modules/tender: invalid condition operators (`{"and": [...]}` instead of `{"op": "and", "children": [...]}`,
 *   and `"is_null"` instead of `"empty"`, #162), which silently evaluated to false for every install.
 *
 * This test suite guarantees seed SQL cannot drift from engine and executor requirements.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActionConfigSchema,
  ConditionTreeSchema,
  TRIGGER_CONFIG_SCHEMAS,
  TriggerTypeSchema,
} from "../../src/routes/automation-rules/schemas.js";

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

interface ParsedSeedRule {
  triggerType: string;
  triggerConfig: unknown;
  conditions: unknown | null;
  actions: unknown[];
}

/**
 * Pure, safe deterministic parser for PostgreSQL jsonb_build_object / jsonb_build_array expressions.
 * ZERO eval / new Function -- eliminates any code injection or ReDoS risk.
 */
function parseJsonbBuildExpr(expr: string): unknown {
  let pos = 0;

  function skipWhitespace() {
    while (pos < expr.length && /\s/.test(expr[pos])) pos++;
  }

  function parseString(): string {
    pos++; // skip opening '
    let s = "";
    while (pos < expr.length) {
      if (expr[pos] === "'") {
        if (expr[pos + 1] === "'") {
          s += "'";
          pos += 2;
        } else {
          pos++; // skip closing '
          break;
        }
      } else {
        s += expr[pos];
        pos++;
      }
    }
    return s;
  }

  function parseValue(): unknown {
    skipWhitespace();
    if (pos >= expr.length) return null;

    if (expr[pos] === "'") {
      return parseString();
    }

    if (expr.startsWith("jsonb_build_object", pos)) {
      pos += "jsonb_build_object".length;
      skipWhitespace();
      if (expr[pos] !== "(")
        throw new Error("Expected ( after jsonb_build_object at " + pos);
      pos++; // skip (
      const obj: Record<string, unknown> = {};
      while (pos < expr.length) {
        skipWhitespace();
        if (expr[pos] === ")") {
          pos++;
          break;
        }
        const key = parseValue();
        if (typeof key !== "string")
          throw new Error("Object key must be string at " + pos);
        skipWhitespace();
        if (expr[pos] !== ",")
          throw new Error("Expected , after object key at " + pos);
        pos++; // skip ,
        const val = parseValue();
        obj[key] = val;
        skipWhitespace();
        if (expr[pos] === ",") {
          pos++;
        } else if (expr[pos] === ")") {
          pos++;
          break;
        }
      }
      return obj;
    }

    if (expr.startsWith("jsonb_build_array", pos)) {
      pos += "jsonb_build_array".length;
      skipWhitespace();
      if (expr[pos] !== "(")
        throw new Error("Expected ( after jsonb_build_array at " + pos);
      pos++; // skip (
      const arr: unknown[] = [];
      while (pos < expr.length) {
        skipWhitespace();
        if (expr[pos] === ")") {
          pos++;
          break;
        }
        arr.push(parseValue());
        skipWhitespace();
        if (expr[pos] === ",") {
          pos++;
        } else if (expr[pos] === ")") {
          pos++;
          break;
        }
      }
      return arr;
    }

    if (expr[pos] === "(") {
      // Subquery or parenthesized expression e.g. (SELECT id::text FROM ...)
      let depth = 1;
      pos++;
      while (pos < expr.length && depth > 0) {
        if (expr[pos] === "(") depth++;
        else if (expr[pos] === ")") depth--;
        pos++;
      }
      // Return a valid mock UUID placeholder for foreign key / entity type references
      return "00000000-0000-0000-0000-000000000000";
    }

    const match = expr.slice(pos).match(/^([a-zA-Z0-9_-]+)/);
    if (match) {
      pos += match[1].length;
      const val = match[1];
      if (val.toLowerCase() === "null") return null;
      if (val.toLowerCase() === "true") return true;
      if (val.toLowerCase() === "false") return false;
      return val;
    }

    return null;
  }

  return parseValue();
}

function parseRulesFromSql(sql: string, filePath: string): ParsedSeedRule[] {
  const statements = sql.split(/INSERT\s+INTO\s+automation_rules/i).slice(1);

  const rules: ParsedSeedRule[] = [];

  for (const stmt of statements) {
    const semiIdx = stmt.indexOf(";");
    const body = semiIdx !== -1 ? stmt.slice(0, semiIdx) : stmt;

    const triggerMatch = body.match(/'([a-z]+\.[a-z_]+)'/i);
    if (!triggerMatch) {
      throw new Error(
        `${filePath}: could not find trigger_type string literal`,
      );
    }
    const triggerType = triggerMatch[1];

    const objMatches = Array.from(
      body.matchAll(/'(\{(?:''|[^'])*?\})'::jsonb/g),
      (m) => m[1],
    );

    const arrMatches = Array.from(
      body.matchAll(/'(\[(?:''|[^'])*?\])'::jsonb/g),
      (m) => m[1],
    );

    if (arrMatches.length === 0) {
      throw new Error(
        `${filePath}: could not find actions array jsonb literal`,
      );
    }
    const actions = JSON.parse(arrMatches[0]);

    if (objMatches.length === 0) {
      throw new Error(
        `${filePath}: could not find trigger_config jsonb literal`,
      );
    }
    const triggerConfig = JSON.parse(objMatches[0]);

    let conditions: unknown | null = null;
    if (objMatches.length > 1) {
      conditions = JSON.parse(objMatches[1]);
    } else if (body.includes("jsonb_build_object")) {
      const match = body.match(/jsonb_build_object\s*\([\s\S]*?\)\s*\)\s*\)/i);
      if (match) {
        conditions = parseJsonbBuildExpr(match[0]);
      }
    } else {
      const afterTrigger = body.slice(
        body.indexOf(objMatches[0]) + objMatches[0].length,
      );
      const beforeActions = afterTrigger.slice(
        0,
        afterTrigger.indexOf(arrMatches[0]),
      );
      if (!/\bNULL\b/i.test(beforeActions)) {
        throw new Error(
          `${filePath}: conditions is neither an object jsonb nor NULL`,
        );
      }
    }

    rules.push({
      triggerType,
      triggerConfig,
      conditions,
      actions,
    });
  }

  return rules;
}

describe("module-seed automation rule coverage guard (#827)", () => {
  const seedFiles = findAutomationRuleSeedFiles();

  it("found at least one automation-rule seed file to check (guards against this test silently checking nothing)", () => {
    expect(seedFiles.length).toBeGreaterThan(0);
  });

  it.each(seedFiles.map((f) => [f] as const))(
    "every automation rule in %s matches schemas for trigger_type, trigger_config, conditions, and actions",
    (filePath) => {
      const sql = readFileSync(filePath, "utf8");
      const rules = parseRulesFromSql(sql, filePath);
      expect(
        rules.length,
        `no automation rules found in ${filePath} -- parseRulesFromSql assumptions may no longer hold`,
      ).toBeGreaterThan(0);

      for (const rule of rules) {
        // 1. Validate trigger_type
        const triggerTypeRes = TriggerTypeSchema.safeParse(rule.triggerType);
        if (!triggerTypeRes.success) {
          throw new Error(
            `${filePath}: trigger_type "${rule.triggerType}" fails TriggerTypeSchema: ${triggerTypeRes.error.message}`,
          );
        }

        // 2. Validate trigger_config against the specific schema for trigger_type
        const configSchema =
          TRIGGER_CONFIG_SCHEMAS[
            rule.triggerType as keyof typeof TRIGGER_CONFIG_SCHEMAS
          ];
        expect(
          configSchema,
          `${filePath}: no config schema found for trigger_type "${rule.triggerType}"`,
        ).toBeDefined();

        const triggerConfigRes = configSchema.safeParse(rule.triggerConfig);
        if (!triggerConfigRes.success) {
          throw new Error(
            `${filePath}: trigger_config ${JSON.stringify(rule.triggerConfig)} fails schema for "${rule.triggerType}": ${triggerConfigRes.error.message}`,
          );
        }

        // 3. Validate conditions (if present) against ConditionTreeSchema
        if (rule.conditions !== null) {
          const conditionRes = ConditionTreeSchema.safeParse(rule.conditions);
          if (!conditionRes.success) {
            throw new Error(
              `${filePath}: conditions ${JSON.stringify(rule.conditions)} fails ConditionTreeSchema: ${conditionRes.error.message}`,
            );
          }
        }

        // 4. Validate actions array elements against ActionConfigSchema
        expect(
          Array.isArray(rule.actions),
          `${filePath}: actions must be an array`,
        ).toBe(true);
        for (const action of rule.actions) {
          const actionRes = ActionConfigSchema.safeParse(action);
          if (!actionRes.success) {
            throw new Error(
              `${filePath}: action ${JSON.stringify(action)} fails ActionConfigSchema: ${actionRes.error.message}`,
            );
          }
        }
      }
    },
  );

  it("regression guard: ConditionTreeSchema rejects invalid operator typos (e.g. 'equals' or 'is_null')", () => {
    const invalidOp = { field: "priority", op: "equals", value: "high" };
    expect(ConditionTreeSchema.safeParse(invalidOp).success).toBe(false);

    const oldBugOp = { field: "status", op: "is_null" };
    expect(ConditionTreeSchema.safeParse(oldBugOp).success).toBe(false);

    const validOp = { field: "priority", op: "eq", value: "high" };
    expect(ConditionTreeSchema.safeParse(validOp).success).toBe(true);
  });

  it("regression guard: TRIGGER_CONFIG_SCHEMAS rejects casing errors and unknown keys (e.g. 'entitytype')", () => {
    const invalidKey = { entitytype: "ticket" };
    expect(
      TRIGGER_CONFIG_SCHEMAS["entity.created"].safeParse(invalidKey).success,
    ).toBe(false);

    const validKey = { entityType: "ticket" };
    expect(
      TRIGGER_CONFIG_SCHEMAS["entity.created"].safeParse(validKey).success,
    ).toBe(true);
  });
});
