/**
 * R13: a plugin migration creating a table without tenant_id + RLS must be rejected
 * before it ever runs — the schema-per-plugin shape (R4) isolates plugins from each
 * other, not tenants from each other within one plugin's own tables.
 *
 * This is a lightweight, regex-based static check — not a full SQL parser — sufficient
 * to catch the exact signature this repo's every other tenant-scoped table follows
 * (see db-conventions.md: "Every tenant-scoped table requires tenant_id + RLS policy +
 * index"), not to validate arbitrary SQL semantics. A table that is genuinely not
 * tenant-scoped (a static reference/lookup table, no tenant data) needs an explicit
 * opt-out — mirroring this repo's own `-- analytics: excluded (reason)` convention —
 * rather than a silent bypass: a `-- plugin-lint: not-tenant-scoped (reason)` comment
 * immediately before that CREATE TABLE statement.
 */

export interface MigrationLintResult {
  ok: boolean;
  violations: string[];
}

const CREATE_TABLE_RE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi;
const NOT_TENANT_SCOPED_MARKER = /--\s*plugin-lint:\s*not-tenant-scoped/i;

/**
 * Returns the source text immediately preceding a CREATE TABLE match's start index,
 * up to (but not including) the previous statement — used to look for the opt-out
 * comment directly above this specific table, not anywhere in the file.
 */
function precedingComment(sql: string, matchStart: number): string {
  const priorStatementEnd = sql.lastIndexOf(";", matchStart - 1);
  return sql.slice(priorStatementEnd + 1, matchStart);
}

export function lintPluginMigration(sql: string): MigrationLintResult {
  const violations: string[] = [];
  const re = new RegExp(CREATE_TABLE_RE);
  let match: RegExpExecArray | null;

  while ((match = re.exec(sql)) !== null) {
    const [, tableName, columnsBlock] = match;
    if (!tableName) continue;

    if (NOT_TENANT_SCOPED_MARKER.test(precedingComment(sql, match.index))) {
      continue; // explicit, reviewed opt-out — same posture as `-- analytics: excluded`
    }

    const hasTenantId = /"?tenant_id"?\s+uuid\s+NOT\s+NULL/i.test(
      columnsBlock ?? "",
    );
    if (!hasTenantId) {
      violations.push(
        `table "${tableName}": no "tenant_id uuid NOT NULL" column, and no ` +
          `"-- plugin-lint: not-tenant-scoped" opt-out comment above it`,
      );
      continue; // RLS check is only meaningful once tenant_id actually exists
    }

    const enableRlsRe = new RegExp(
      `ALTER\\s+TABLE\\s+"?${tableName}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      "i",
    );
    const createPolicyRe = new RegExp(
      `CREATE\\s+POLICY\\s+\\S+\\s+ON\\s+"?${tableName}"?`,
      "i",
    );

    if (!enableRlsRe.test(sql)) {
      violations.push(
        `table "${tableName}": has tenant_id but no ENABLE ROW LEVEL SECURITY statement`,
      );
    }
    if (!createPolicyRe.test(sql)) {
      violations.push(
        `table "${tableName}": has tenant_id but no CREATE POLICY statement`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}
