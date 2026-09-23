import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { logger } from "@platform/logger";
import { writeAuditEntry } from "@platform/audit";
import { listOrgUsers } from "../../lib/zitadel-management.js";
import { factory } from "./factory.js";
import { zValidator } from "../../lib/validator.js";

/**
 * Build Your Own Query (BYOQ) Schema
 * Exposes business-friendly fields, operations, filter operators, and grouping dimensions.
 */
export const FilterRuleSchema = z.object({
  field: z.enum([
    "status",
    "priority",
    "assignee",
    "department",
    "category",
    "createdAt",
    "resolvedAt",
  ]),
  operator: z.enum([
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "contains",
    "is_empty",
    "is_not_empty",
    "between",
  ]),
  value: z
    .union([
      z.string(),
      z.number(),
      z.array(z.string()),
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
      }),
      z.null(),
    ])
    .optional(),
});

export type FilterRule = z.infer<typeof FilterRuleSchema>;

export const BYOQuerySchema = z.object({
  // "total_hours" was previously accepted here but never implemented (fell
  // through to the same placeholder aggregate as sla_margin) and was never
  // offered in the UI - dropped rather than left reachable-but-broken via a
  // direct API call. Re-add only alongside a real column and a UI surface.
  measure: z
    .enum(["tickets", "resolution_time", "sla_margin"])
    .default("tickets"),
  operation: z
    .enum(["count", "average", "sum", "min", "max", "median"])
    .default("count"),
  groupBy: z
    .enum([
      "none",
      "status",
      "priority",
      "department",
      "assignee",
      "category",
      "day",
      "week",
      "month",
    ])
    .default("none"),
  // Capped rather than unbounded (docs/specs/byoq-hardening.md, query-cost
  // bounds) - each filter adds a clause to every one of the three queries
  // this route runs per request; an unbounded array is a cheap way to build
  // an expensive query without needing anything resembling injection.
  filters: z.array(FilterRuleSchema).max(20).default([]),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type BYOQueryInput = z.infer<typeof BYOQuerySchema>;

export type BYORow = {
  id: string;
  title: string;
  status: string;
  statusKey: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string;
  raiserId: string | null;
  raiserName: string;
  department: string;
  category: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionTimeHours: number | null;
  isClosed: boolean;
};

export type BYOGroup = {
  key: string;
  label: string;
  /** null when this group has nothing to measure — see the note on summary.value. */
  value: number | null;
  percentage: number;
  count: number;
};

export type BYOQueryResponse = {
  summary: {
    measure: string;
    operation: string;
    /**
     * null when there is nothing to measure — no rows matched, or the matched
     * rows carry no value for this measure (e.g. SLA margin where no workflow
     * state defines `sla_hours`). Deliberately not coalesced to 0: a real zero
     * and an absent measurement are different answers and read identically
     * once flattened. `formattedValue` carries the reason.
     */
    value: number | null;
    formattedValue: string;
    totalRows: number;
  };
  groups: BYOGroup[];
  rows: BYORow[];
  meta: {
    groupBy: string;
    isScopedToUser: boolean;
    appliedFiltersCount: number;
  };
};

/**
 * Formats a metric value into a readable business string
 */
function formatMetricValue(
  measure: string,
  operation: string,
  val: number | null,
  totalRows: number,
): string {
  // No value at all. Say which kind of nothing it is, because the two have
  // different fixes and a bare "0" hides both: either the filters matched no
  // tickets, or they matched tickets that carry nothing to measure.
  if (val === null) {
    if (totalRows === 0) return "No tickets match";
    if (measure === "sla_margin") return "No SLA configured";
    if (measure === "resolution_time") return "No resolved tickets";
    return "No data";
  }
  if (operation === "count" || measure === "tickets") {
    return `${Math.round(val).toLocaleString()} ${
      Math.round(val) === 1 ? "Ticket" : "Tickets"
    }`;
  }
  if (measure === "resolution_time" || measure === "sla_margin") {
    if (val < 1) {
      const mins = Math.round(val * 60);
      return `${mins} min${mins === 1 ? "" : "s"}`;
    }
    return `${val.toFixed(1)} hrs`;
  }
  return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Fire-and-forget by design (docs/specs/byoq-hardening.md): the audit
// entry is written in its own short transaction, separate from the query
// transaction, since a failed query's transaction is already aborted by
// the time the catch block runs and cannot accept another statement. A
// failure here is logged, never surfaced to the caller or allowed to turn
// a successful BYOQ query into a 500 - matches the existing
// "log and fail open" convention used elsewhere in this codebase for
// non-critical side effects (e.g. the tenant rate-limit check).
async function recordReportingAudit(
  tenantId: string,
  userId: string,
  action: "reporting.query_executed" | "reporting.query_failed",
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenantContext(tenantId, (tx) =>
      writeAuditEntry(tx, {
        tenantId,
        actorId: userId,
        actorType: userId.startsWith("apikey:") ? "api_key" : "user",
        resourceType: "reporting",
        // The audit table wants a resource UUID and a BYOQ query has no
        // durable id of its own - each entry gets its own, same reasoning
        // as record_reporting_audit() (migration 0115)'s own comment.
        resourceId: randomUUID(),
        action,
        metadata,
      }),
    );
  } catch (auditErr) {
    logger.warn(
      { tenantId, userId, action, auditErr },
      "BYOQ: failed to write audit entry",
    );
  }
}

export const executeBYOQueryHandler = factory.createHandlers(
  requireAuth(),
  // Matches guest-token.ts's dashboard-path allowlist exactly - a role
  // outside these three gets a clean 403 instead of silently reaching the
  // query engine and getting treated as self-scoped.
  requireRole("agent", "admin", "user"),
  zValidator("json", BYOQuerySchema),
  async (c) => {
    const { tenantId, userId, roles, orgId } = c.get("auth");
    const input = c.req.valid("json");

    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    try {
      // 1. Fetch tenant org users for assignee name resolution
      let usersMap: Map<string, string> = new Map();
      try {
        const orgUsers = await listOrgUsers(orgId ?? tenantId);
        usersMap = new Map(
          orgUsers.map((u) => [u.userId, u.displayName || u.email || u.userId]),
        );
      } catch {
        // Fallback gracefully if Zitadel is offline in test/mock mode
      }

      // 2. Execute query within tenant context
      const result = await withTenantContext(tenantId, async (tx) => {
        // Query-cost bound (docs/specs/byoq-hardening.md): an ad-hoc filter
        // combination can still be expensive even capped at 20 filters and
        // 500 rows - this is the backstop, scoped to just this transaction
        // (SET LOCAL, not SET) so it can never leak into any other query on
        // the same pooled connection.
        await tx.execute(sql`SET LOCAL statement_timeout = '5000'`);

        // Every filter/user/tenant VALUE below reaches Postgres as a bound
        // parameter via plain `${...}` interpolation inside a drizzle-orm
        // `sql` template — never string-concatenated into the query text.
        // `sql.raw(...)` is used only for the small, fixed set of column
        // references built from the `switch` below (never from user input),
        // matching this repo's security rule against hand-built SQL strings.
        const filterClauses: SQL[] = [];

        // Role restriction clause
        if (!isPrivileged) {
          filterClauses.push(
            sql`(tb.created_by = ${userId} OR tb.assigned_to = ${userId})`,
          );
        }

        // Translate user-provided filter rules into safe SQL
        for (const f of input.filters) {
          let col = "";
          switch (f.field) {
            case "status":
              col = "tb.status";
              break;
            case "priority":
              col = "tb.priority";
              break;
            case "assignee":
              col = "tb.assigned_to";
              break;
            case "department":
              col = "tb.department";
              break;
            case "category":
              col = "tb.category";
              break;
            case "createdAt":
              col = "tb.created_at";
              break;
            case "resolvedAt":
              col = "tb.resolved_at";
              break;
          }

          if (!col) continue;
          const colSql = sql.raw(col);

          if (f.operator === "is_empty") {
            filterClauses.push(
              sql`(${colSql} IS NULL OR ${colSql}::text = '')`,
            );
          } else if (f.operator === "is_not_empty") {
            filterClauses.push(
              sql`(${colSql} IS NOT NULL AND ${colSql}::text <> '')`,
            );
          } else if (f.operator === "equals") {
            if (f.value !== undefined && f.value !== null) {
              if (f.field === "assignee" && f.value === "unassigned") {
                filterClauses.push(sql`tb.assigned_to IS NULL`);
              } else {
                filterClauses.push(
                  sql`LOWER(${colSql}::text) = LOWER(${String(f.value)})`,
                );
              }
            }
          } else if (f.operator === "not_equals") {
            if (f.value !== undefined && f.value !== null) {
              if (f.field === "assignee" && f.value === "unassigned") {
                filterClauses.push(sql`tb.assigned_to IS NOT NULL`);
              } else {
                filterClauses.push(
                  sql`(${colSql} IS NULL OR LOWER(${colSql}::text) <> LOWER(${String(f.value)}))`,
                );
              }
            }
          } else if (f.operator === "contains") {
            if (f.value !== undefined && f.value !== null) {
              filterClauses.push(
                sql`LOWER(${colSql}::text) LIKE ${`%${String(f.value).toLowerCase()}%`}`,
              );
            }
          } else if (f.operator === "greater_than") {
            if (f.value !== undefined && f.value !== null) {
              filterClauses.push(sql`${colSql} > ${String(f.value)}`);
            }
          } else if (f.operator === "less_than") {
            if (f.value !== undefined && f.value !== null) {
              filterClauses.push(sql`${colSql} < ${String(f.value)}`);
            }
          } else if (
            // f.operator can only be "between" here - every other
            // FilterOperator member is handled by an earlier branch above.
            typeof f.value === "object" &&
            f.value !== null
          ) {
            const range = f.value as { from?: string; to?: string };
            if (range.from && range.to) {
              filterClauses.push(
                sql`${colSql} >= ${range.from} AND ${colSql} <= ${range.to}`,
              );
            } else if (range.from) {
              filterClauses.push(sql`${colSql} >= ${range.from}`);
            } else if (range.to) {
              filterClauses.push(sql`${colSql} <= ${range.to}`);
            }
          }
        }

        const whereSql =
          filterClauses.length > 0
            ? sql`WHERE ${sql.join(filterClauses, sql` AND `)}`
            : sql``;

        // Aggregation SQL expression - built entirely from validated Zod
        // enums (input.measure/input.operation), never from free-text user
        // input, so sql.raw() here carries no injection surface.
        let aggExpr = "COUNT(*)::numeric";
        let measureCol = "1";
        if (input.measure === "resolution_time") {
          measureCol = "tb.resolution_time_hours";
        } else if (input.measure === "sla_margin") {
          measureCol = "tb.sla_margin_hours";
        }

        // Deliberately NOT wrapped in COALESCE(..., 0) except for count.
        //
        // COUNT over nothing is genuinely 0 — "no tickets matched" is a real
        // answer. Every other operation over nothing has no answer at all, and
        // coalescing it to 0 turns "there is nothing to measure" into a number
        // indistinguishable from a real result.
        //
        // That is not hypothetical here. No workflow state that tickets
        // actually occupy sets `sla_hours`, so `tb.sla_margin_hours` is NULL for
        // every row, and the SLA Margin measure reported a confident "0 hrs"
        // rather than admitting it had nothing to work with. §B B1 in
        // docs/specs/byoq-hardening.md caught the same class of bug when this
        // measure returned a fabricated 1; replacing that with a fabricated 0
        // fixed the symptom and left the defect.
        //
        // NULL reaches the mapping below, which distinguishes "no rows matched"
        // from "rows matched but the measure is not available" and says which.
        if (input.operation === "count") {
          aggExpr = "COUNT(*)::numeric";
        } else if (input.operation === "average") {
          aggExpr = `AVG(${measureCol})::numeric`;
        } else if (input.operation === "sum") {
          aggExpr = `SUM(${measureCol})::numeric`;
        } else if (input.operation === "min") {
          aggExpr = `MIN(${measureCol})::numeric`;
        } else if (input.operation === "max") {
          aggExpr = `MAX(${measureCol})::numeric`;
        } else {
          // input.operation can only be "median" here - every other
          // OPERATION_OPTIONS member is handled by an earlier branch above.
          aggExpr = `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${measureCol})::numeric`;
        }

        // Dimension expression for GROUP BY
        let groupColExpr = "NULL::text AS group_key, NULL::text AS group_label";
        let groupBySql = "";
        if (input.groupBy === "status") {
          groupColExpr = "tb.status_key AS group_key, tb.status AS group_label";
          groupBySql = "GROUP BY tb.status_key, tb.status";
        } else if (input.groupBy === "priority") {
          groupColExpr = "tb.priority AS group_key, tb.priority AS group_label";
          groupBySql = "GROUP BY tb.priority";
        } else if (input.groupBy === "department") {
          groupColExpr =
            "tb.department AS group_key, tb.department AS group_label";
          groupBySql = "GROUP BY tb.department";
        } else if (input.groupBy === "category") {
          groupColExpr = "tb.category AS group_key, tb.category AS group_label";
          groupBySql = "GROUP BY tb.category";
        } else if (input.groupBy === "assignee") {
          groupColExpr =
            "COALESCE(tb.assigned_to, 'unassigned') AS group_key, COALESCE(tb.assigned_to, 'Unassigned') AS group_label";
          groupBySql = "GROUP BY tb.assigned_to";
        } else if (input.groupBy === "day") {
          groupColExpr =
            "TO_CHAR(tb.created_at, 'YYYY-MM-DD') AS group_key, TO_CHAR(tb.created_at, 'Mon DD, YYYY') AS group_label";
          groupBySql =
            "GROUP BY TO_CHAR(tb.created_at, 'YYYY-MM-DD'), TO_CHAR(tb.created_at, 'Mon DD, YYYY') ORDER BY group_key ASC";
        } else if (input.groupBy === "week") {
          groupColExpr =
            "TO_CHAR(DATE_TRUNC('week', tb.created_at), 'YYYY-\"W\"IW') AS group_key, TO_CHAR(DATE_TRUNC('week', tb.created_at), '\"Week of\" Mon DD') AS group_label";
          groupBySql =
            "GROUP BY DATE_TRUNC('week', tb.created_at) ORDER BY group_key ASC";
        } else if (input.groupBy === "month") {
          groupColExpr =
            "TO_CHAR(tb.created_at, 'YYYY-MM') AS group_key, TO_CHAR(tb.created_at, 'Month YYYY') AS group_label";
          groupBySql =
            "GROUP BY TO_CHAR(tb.created_at, 'YYYY-MM'), TO_CHAR(tb.created_at, 'Month YYYY') ORDER BY group_key ASC";
        }

        // Base CTE - tenantId reaches Postgres as a bound parameter (${tenantId}
        // below), same as every filter value, never string-interpolated.
        // sla_margin_hours reuses resolution_time_hours' own COALESCE (rather
        // than referencing that alias, which a single SELECT list can't do)
        // against ws.sla_hours from the same current-state join
        // docker/superset/bootstrap.py's sla_margin_hours column uses.
        const baseQuery = sql`
          WITH terminal_events AS (
            SELECT we.instance_id,
                   MIN(we.created_at) AS resolved_at,
                   EXTRACT(EPOCH FROM (MIN(we.created_at) - MIN(ei_inner.created_at)))/3600.0 AS resolution_hours
            FROM workflow_events we
            JOIN entity_instances ei_inner ON ei_inner.id = we.instance_id
            JOIN workflow_states ws_term ON ws_term.workflow_id = ei_inner.workflow_id
                 AND ws_term.name = we.to_state AND ws_term.is_terminal = true
            GROUP BY we.instance_id
          ),
          ticket_base AS (
            SELECT
              ei.id AS instance_id,
              ei.tenant_id,
              COALESCE(ei.fields->>'title', ei.fields->>'subject', ei.fields->>'name', 'Ticket #' || SUBSTRING(ei.id::text, 1, 8)) AS title,
              ei.current_state AS status_key,
              COALESCE(ws.label, ei.current_state) AS status,
              COALESCE(NULLIF(ei.fields->>'priority', ''), 'Medium') AS priority,
              ei.assigned_to,
              ei.created_by,
              COALESCE(NULLIF(ei.fields->>'department', ''), 'General') AS department,
              COALESCE(NULLIF(ei.fields->>'category', ''), 'Support') AS category,
              ei.created_at,
              COALESCE(te.resolved_at, CASE WHEN ws.is_terminal THEN ei.updated_at ELSE NULL END) AS resolved_at,
              COALESCE(te.resolution_hours, CASE WHEN ws.is_terminal THEN EXTRACT(EPOCH FROM (ei.updated_at - ei.created_at))/3600.0 ELSE NULL END) AS resolution_time_hours,
              CASE WHEN ws.sla_hours IS NULL THEN NULL
                   ELSE ws.sla_hours - COALESCE(te.resolution_hours, CASE WHEN ws.is_terminal THEN EXTRACT(EPOCH FROM (ei.updated_at - ei.created_at))/3600.0 ELSE NULL END)
              END AS sla_margin_hours,
              COALESCE(ws.is_terminal, false) AS is_closed
            FROM entity_instances ei
            LEFT JOIN workflows w ON w.id = ei.workflow_id
            LEFT JOIN workflow_states ws ON ws.workflow_id = ei.workflow_id AND ws.name = ei.current_state
            LEFT JOIN terminal_events te ON te.instance_id = ei.id
            WHERE ei.tenant_id = ${tenantId}
              AND ei.deleted_at IS NULL
          )
        `;

        // aggExpr/groupColExpr/groupBySql are built above entirely from
        // validated Zod enums (input.measure/operation/groupBy), never from
        // free-text user input - sql.raw() here carries no injection surface,
        // same reasoning as colSql above.
        const aggExprSql = sql.raw(aggExpr);
        const groupColExprSql = sql.raw(groupColExpr);
        const groupBySqlFragment = sql.raw(groupBySql);

        // 1. Overall Summary Metric
        const summarySql = sql`${baseQuery}
          SELECT
            ${aggExprSql} AS aggregate_value,
            COUNT(*)::integer AS total_rows
          FROM ticket_base tb
          ${whereSql}
        `;

        // 2. Group By breakdown (if requested)
        const groupsSql =
          input.groupBy !== "none"
            ? sql`${baseQuery}
             SELECT
               ${groupColExprSql},
               ${aggExprSql} AS group_value,
               COUNT(*)::integer AS row_count
             FROM ticket_base tb
             ${whereSql}
             ${groupBySqlFragment}
             ${sql.raw(/day|week|month/.test(input.groupBy) ? "" : "ORDER BY group_value DESC")}
             LIMIT 50`
            : null;

        // 3. Detail records for table / export. input.limit/input.offset are
        // Zod-validated numbers (z.coerce.number().int().min/max), bound as
        // parameters the same as any other value here.
        const rowsSql = sql`${baseQuery}
          SELECT
            tb.instance_id,
            tb.title,
            tb.status,
            tb.status_key,
            tb.priority,
            tb.assigned_to,
            tb.created_by,
            tb.department,
            tb.category,
            tb.created_at,
            tb.resolved_at,
            tb.resolution_time_hours,
            tb.is_closed
          FROM ticket_base tb
          ${whereSql}
          ORDER BY tb.created_at DESC
          LIMIT ${input.limit} OFFSET ${input.offset}
        `;

        // Execute queries in parallel
        const summaryResultPromise = tx.execute(summarySql);
        const groupsResultPromise = groupsSql
          ? tx.execute(groupsSql)
          : Promise.resolve([]);
        const rowsResultPromise = tx.execute(rowsSql);

        const [summaryRes, groupsRes, rowsRes] = await Promise.all([
          summaryResultPromise,
          groupsResultPromise,
          rowsResultPromise,
        ]);

        const getRows = (res: unknown): Record<string, unknown>[] => {
          if (!res) return [];
          if (Array.isArray(res)) return res as Record<string, unknown>[];
          if (
            typeof res === "object" &&
            "rows" in res &&
            Array.isArray((res as { rows: unknown }).rows)
          ) {
            return (res as { rows: Record<string, unknown>[] }).rows;
          }
          return [];
        };

        const summaryRows = getRows(summaryRes);
        const groupRows = getRows(groupsRes);
        const dataRows = getRows(rowsRes);

        return {
          // aggregate_value is NULL when there is nothing to measure — see the
          // note on aggExpr.
          summaryRow: (summaryRows[0] ?? {}) as {
            aggregate_value?: string | number | null;
            total_rows?: number;
          },
          groupRows: groupRows as unknown as Array<{
            group_key: string | null;
            group_label: string | null;
            group_value: string | number | null | undefined;
            row_count: number | null | undefined;
          }>,
          dataRows,
        };
      });

      // Parse summary values.
      //
      // NULL from the aggregate means "nothing to measure", which is a
      // different statement from zero and must not be flattened into one. Only
      // count is guaranteed a number; see the aggExpr note above.
      const totalCount = Number(result.summaryRow.total_rows ?? 0);
      const rawAgg = result.summaryRow.aggregate_value;
      const hasValue = rawAgg !== null && rawAgg !== undefined;
      const rawVal = hasValue ? Number(rawAgg) : null;

      // Format groups with user name resolution & percentages
      const groups: BYOGroup[] = result.groupRows.map((g) => {
        // Same rule as the summary: a group whose measure is NULL has nothing
        // to report, and rendering it as a zero-height bar next to real bars
        // states something untrue about it.
        const hasGroupValue =
          g.group_value !== null && g.group_value !== undefined;
        const val = hasGroupValue ? Number(g.group_value) : null;
        let label = g.group_label ?? g.group_key ?? "Unspecified";

        if (input.groupBy === "assignee" && g.group_key) {
          if (g.group_key === "unassigned") {
            label = "Unassigned";
          } else {
            label = usersMap.get(g.group_key) ?? g.group_key;
          }
        }

        // A share of nothing is not zero percent, it is undefined — so a group
        // with no measurable value reports 0 here only as a layout fallback,
        // and `value: null` is what tells the client not to draw it as data.
        const denominator =
          input.operation === "count" ? totalCount : Math.max(rawVal ?? 0, 1);
        const percentage =
          val !== null && totalCount > 0
            ? Number(((val / denominator) * 100).toFixed(1))
            : 0;

        return {
          key: g.group_key ?? "unspecified",
          label,
          value: val === null ? null : Number(val.toFixed(2)),
          percentage,
          count: Number(g.row_count ?? 0),
        };
      });

      const toTitleCase = (val: string | null | undefined): string => {
        if (!val) return "";
        const s = val.trim();
        if (s.toLowerCase() === "hr") return "HR";
        if (s.toLowerCase() === "it") return "IT";
        return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
      };

      // An empty string from the driver is as meaningless as null for these
      // display fields, so both fall back to the friendly default.
      const orFallback = (value: unknown, fallback: string): string => {
        const s = value === null || value === undefined ? "" : String(value);
        return s === "" ? fallback : s;
      };

      // Map rows with user display names and standardized Title Case.
      const rows: BYORow[] = result.dataRows.map((r) => {
        const assigneeId = (r.assigned_to as string) || null;
        const raiserId = (r.created_by as string) || null;

        return {
          id: String(r.instance_id),
          title: orFallback(r.title, "Untitled"),
          status: orFallback(r.status, "Unknown"),
          statusKey: orFallback(r.status_key, "unknown"),
          priority: toTitleCase(orFallback(r.priority, "Medium")),
          assigneeId,
          assigneeName: assigneeId
            ? (usersMap.get(assigneeId) ?? assigneeId)
            : "Unassigned",
          raiserId,
          raiserName: raiserId
            ? (usersMap.get(raiserId) ?? raiserId)
            : "Unknown",
          department: toTitleCase(orFallback(r.department, "General")),
          category: toTitleCase(orFallback(r.category, "Support")),
          createdAt: new Date(r.created_at as string).toISOString(),
          resolvedAt: r.resolved_at
            ? new Date(r.resolved_at as string).toISOString()
            : null,
          resolutionTimeHours:
            r.resolution_time_hours !== null &&
            r.resolution_time_hours !== undefined
              ? Number(Number(r.resolution_time_hours).toFixed(2))
              : null,
          isClosed: Boolean(r.is_closed),
        };
      });

      const response: BYOQueryResponse = {
        summary: {
          measure: input.measure,
          operation: input.operation,
          value: rawVal === null ? null : Number(rawVal.toFixed(2)),
          formattedValue: formatMetricValue(
            input.measure,
            input.operation,
            rawVal,
            totalCount,
          ),
          totalRows: totalCount,
        },
        groups,
        rows,
        meta: {
          groupBy: input.groupBy,
          isScopedToUser: !isPrivileged,
          appliedFiltersCount: input.filters.length,
        },
      };

      await recordReportingAudit(tenantId, userId, "reporting.query_executed", {
        measure: input.measure,
        operation: input.operation,
        groupBy: input.groupBy,
        filterCount: input.filters.length,
        isScopedToUser: !isPrivileged,
        totalRows: totalCount,
      });

      return c.json({ data: response });
    } catch (err) {
      // The real error (often raw driver/SQL detail) is logged server-side
      // with context for debugging, never returned to the client - avoids
      // leaking column names, query fragments, or other internals.
      logger.error({ tenantId, userId, err }, "BYOQ query execution failed");
      await recordReportingAudit(tenantId, userId, "reporting.query_failed", {
        measure: input.measure,
        operation: input.operation,
        groupBy: input.groupBy,
        filterCount: input.filters.length,
      });
      return c.json(
        {
          error: "QUERY_EXECUTION_ERROR",
          message: "Failed to execute query",
        },
        500,
      );
    }
  },
);
