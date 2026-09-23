import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import { PgDialect } from "drizzle-orm/pg-core";
import { executeBYOQueryHandler } from "./query.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const authState: AuthContext = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  userId: "user-123",
  roles: ["admin"],
  email: "admin@example.com",
} as AuthContext;

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", authState);
      await next();
    },
  // Real implementation's shape (packages/auth/src/middleware.ts:686-700),
  // reproduced rather than stubbed to a no-op - the whole point of the
  // requireRole addition (R3 in docs/specs/byoq-hardening.md) is that a
  // disallowed role gets 403, which a no-op mock would silently hide.
  requireRole:
    (...roles: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const auth = c.get("auth");
      const hasRole = roles.some((r) => auth.roles.includes(r));
      if (!hasRole) {
        return c.json(
          { error: "FORBIDDEN", message: "Insufficient permissions" },
          403,
        );
      }
      await next();
      return;
    },
}));

const writeAuditEntryMock = vi.fn(async () => undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntryMock(...args),
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: () =>
    Promise.resolve([
      {
        userId: "user-123",
        displayName: "Admin User",
        email: "admin@example.com",
      },
      {
        userId: "agent-456",
        displayName: "Support Agent",
        email: "agent@example.com",
      },
    ]),
}));

// Each entry is the placeholder-form SQL text ("$1", "$2", ...) plus the
// bound parameter values Drizzle would send to the driver separately - the
// real shape a parameterized query takes, so tests assert against bound
// values rather than the (no-longer-existing) literal-in-text form.
let executedQueries: Array<{ sql: string; params: unknown[] }> = [];
const pgDialect = new PgDialect();
let mockSummaryRows: Array<Record<string, unknown>> = [
  { aggregate_value: "42", total_rows: 42 },
];
let mockGroupRows: Array<Record<string, unknown>> = [
  {
    group_key: "in_progress",
    group_label: "In Progress",
    group_value: "20",
    row_count: 20,
  },
  { group_key: "open", group_label: "Open", group_value: "22", row_count: 22 },
];
let mockDataRows: Array<Record<string, unknown>> = [
  {
    instance_id: "inst-1",
    title: "Server 500 error on checkout",
    status: "In Progress",
    status_key: "in_progress",
    priority: "Urgent",
    assigned_to: "agent-456",
    created_by: "user-123",
    department: "Engineering",
    category: "Bug",
    created_at: "2026-09-18T10:00:00Z",
    resolved_at: null,
    resolution_time_hours: null,
    is_closed: false,
  },
];

vi.mock("@platform/db", () => ({
  withTenantContext: vi.fn(
    async (
      _tenantId: string,
      callback: (tx: {
        execute: (query: unknown) => Promise<unknown>;
      }) => Promise<unknown>,
    ) => {
      const tx = {
        execute: vi.fn(async (q: unknown) => {
          // q is a real drizzle-orm SQL object (built by the `sql` template
          // in query.ts) - converted the same way the real postgres.js
          // driver would, to placeholder text ("$1", "$2", ...) plus a
          // separate bound-params array, since that split is exactly what
          // parameterization (this suite's whole point) is verifying.
          const { sql: sqlText, params } = pgDialect.sqlToQuery(
            q as Parameters<typeof pgDialect.sqlToQuery>[0],
          );
          executedQueries.push({ sql: sqlText, params });

          if (sqlText.includes("total_rows")) {
            return { rows: mockSummaryRows };
          }
          if (sqlText.includes("group_key")) {
            return { rows: mockGroupRows };
          }
          return { rows: mockDataRows };
        }),
      };
      return callback(tx as unknown as Parameters<typeof callback>[0]);
    },
  ),
}));

describe("POST /reporting/query (BYOQ Query Engine)", () => {
  let app: Hono<{ Variables: { auth: AuthContext } }>;

  beforeEach(() => {
    vi.clearAllMocks();
    executedQueries = [];
    authState.roles = ["admin"];
    authState.userId = "user-123";
    mockSummaryRows = [{ aggregate_value: "42", total_rows: 42 }];
    mockGroupRows = [
      {
        group_key: "in_progress",
        group_label: "In Progress",
        group_value: "20",
        row_count: 20,
      },
      {
        group_key: "open",
        group_label: "Open",
        group_value: "22",
        row_count: 22,
      },
    ];
    mockDataRows = [
      {
        instance_id: "inst-1",
        title: "Server 500 error on checkout",
        status: "In Progress",
        status_key: "in_progress",
        priority: "Urgent",
        assigned_to: "agent-456",
        created_by: "user-123",
        department: "Engineering",
        category: "Bug",
        created_at: "2026-09-18T10:00:00Z",
        resolved_at: null,
        resolution_time_hours: null,
        is_closed: false,
      },
    ];

    app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.post("/reporting/query", ...executeBYOQueryHandler);
  });

  it("executes default count query and returns structured response", async () => {
    const res = await app.request("http://localhost/reporting/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        summary: {
          measure: string;
          operation: string;
          value: number;
          formattedValue: string;
        };
        rows: Array<{ title: string; assigneeName: string }>;
        meta: { isScopedToUser: boolean };
      };
    };

    expect(body.data.summary.operation).toBe("count");
    expect(body.data.summary.value).toBe(42);
    expect(body.data.summary.formattedValue).toBe("42 Tickets");
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0]?.assigneeName).toBe("Support Agent");
    expect(body.data.meta.isScopedToUser).toBe(false);
  });

  it("handles filtering by Priority, Department, and Status", async () => {
    const res = await app.request("http://localhost/reporting/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        measure: "tickets",
        operation: "count",
        filters: [
          { field: "priority", operator: "equals", value: "Urgent" },
          { field: "department", operator: "contains", value: "Engine" },
          { field: "status", operator: "not_equals", value: "closed" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { meta: { appliedFiltersCount: number } };
    };
    expect(body.data.meta.appliedFiltersCount).toBe(3);
  });

  it("supports Group By status with percentage calculations", async () => {
    const res = await app.request("http://localhost/reporting/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupBy: "status",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        groups: Array<{
          key: string;
          label: string;
          value: number;
          percentage: number;
        }>;
      };
    };

    expect(body.data.groups).toHaveLength(2);
    expect(body.data.groups[0]?.label).toBe("In Progress");
    expect(body.data.groups[0]?.percentage).toBeCloseTo(47.6, 0.5);
  });

  it("enforces role scoping for standard users", async () => {
    authState.roles = ["user"];
    authState.userId = "user-999";

    const res = await app.request("http://localhost/reporting/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { meta: { isScopedToUser: boolean } };
    };
    expect(body.data.meta.isScopedToUser).toBe(true);
  });

  describe("Measures and Operations matrix", () => {
    const operations = [
      "count",
      "average",
      "sum",
      "min",
      "max",
      "median",
    ] as const;
    // "total_hours" was dropped from the schema (docs/specs/byoq-hardening.md
    // R1/B1) - it was never implemented and never reachable from the UI.
    const measures = ["tickets", "resolution_time", "sla_margin"] as const;

    for (const measure of measures) {
      for (const op of operations) {
        it(`executes measure="${measure}" with operation="${op}" without failing`, async () => {
          mockSummaryRows = [{ aggregate_value: "10.5", total_rows: 25 }];

          const res = await app.request("http://localhost/reporting/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              measure,
              operation: op,
            }),
          });

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            data: {
              summary: { measure: string; operation: string; value: number };
            };
          };
          expect(body.data.summary.measure).toBe(measure);
          expect(body.data.summary.operation).toBe(op);
        });
      }
    }
  });

  describe("Group By Dimensions matrix", () => {
    const groupDimensions = [
      "none",
      "status",
      "priority",
      "department",
      "assignee",
      "category",
      "day",
      "week",
      "month",
    ] as const;

    for (const dimension of groupDimensions) {
      it(`executes group by dimension="${dimension}" without failing`, async () => {
        const res = await app.request("http://localhost/reporting/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            groupBy: dimension,
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: { meta: { groupBy: string } };
        };
        expect(body.data.meta.groupBy).toBe(dimension);
      });
    }
  });

  describe("Filter Operators matrix", () => {
    // Every assertion below checks the placeholder-form SQL text ("$1", not
    // the literal value) plus the separately-bound params array - proving
    // values are parameters, not string-embedded, which is the actual
    // property this suite is meant to lock in (docs/specs/byoq-hardening.md
    // R2). Asserting a literal value still appeared in the SQL *text* would
    // just re-introduce the bug this rewrite fixes.
    it("handles equals and not_equals filter operators", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            { field: "status", operator: "equals", value: "open" },
            { field: "priority", operator: "not_equals", value: "Low" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { appliedFiltersCount: number } };
      };
      expect(body.data.meta.appliedFiltersCount).toBe(2);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("LOWER(tb.status::text) = LOWER(");
      expect(summaryQuery?.sql).toContain("LOWER(tb.priority::text) <> LOWER(");
      expect(summaryQuery?.sql).not.toContain("'open'");
      expect(summaryQuery?.sql).not.toContain("'Low'");
      expect(summaryQuery?.params).toContain("open");
      expect(summaryQuery?.params).toContain("Low");
    });

    it("handles greater_than and less_than filter operators on dates", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            {
              field: "createdAt",
              operator: "greater_than",
              value: "2026-01-01",
            },
            { field: "resolvedAt", operator: "less_than", value: "2026-12-31" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { appliedFiltersCount: number } };
      };
      expect(body.data.meta.appliedFiltersCount).toBe(2);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).not.toContain("2026-01-01");
      expect(summaryQuery?.params).toContain("2026-01-01");
      expect(summaryQuery?.params).toContain("2026-12-31");
    });

    it("handles contains filter operator on string fields", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            { field: "department", operator: "contains", value: "Support" },
            { field: "category", operator: "contains", value: "Billing" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { appliedFiltersCount: number } };
      };
      expect(body.data.meta.appliedFiltersCount).toBe(2);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("LOWER(tb.department::text) LIKE ");
      expect(summaryQuery?.sql).not.toContain("support");
      expect(summaryQuery?.params).toContain("%support%");
      expect(summaryQuery?.params).toContain("%billing%");
    });

    it("handles is_empty and is_not_empty filter operators", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            { field: "assignee", operator: "is_empty" },
            { field: "resolvedAt", operator: "is_not_empty" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { appliedFiltersCount: number } };
      };
      expect(body.data.meta.appliedFiltersCount).toBe(2);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain(
        "(tb.assigned_to IS NULL OR tb.assigned_to::text = '')",
      );
      expect(summaryQuery?.sql).toContain(
        "(tb.resolved_at IS NOT NULL AND tb.resolved_at::text <> '')",
      );
    });

    it("handles between filter operator with from and to date ranges", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            {
              field: "createdAt",
              operator: "between",
              value: { from: "2026-09-01", to: "2026-09-18" },
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { appliedFiltersCount: number } };
      };
      expect(body.data.meta.appliedFiltersCount).toBe(1);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("tb.created_at >= ");
      expect(summaryQuery?.sql).toContain("AND tb.created_at <= ");
      expect(summaryQuery?.sql).not.toContain("2026-09-01");
      expect(summaryQuery?.params).toContain("2026-09-01");
      expect(summaryQuery?.params).toContain("2026-09-18");
    });

    it("handles assignee filter with unassigned keyword", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            { field: "assignee", operator: "equals", value: "unassigned" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { appliedFiltersCount: number } };
      };
      expect(body.data.meta.appliedFiltersCount).toBe(1);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("tb.assigned_to IS NULL");
    });

    it("treats a quote-containing filter value as a literal match, not a SQL break (R2)", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            { field: "department", operator: "equals", value: "O'Brien" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      // The apostrophe never needed escaping in the SQL text at all - it
      // travels as a bound parameter, exactly like any other value. "equals"
      // lowercases in SQL (LOWER(...)), not in JS, so the param itself keeps
      // its original casing.
      expect(summaryQuery?.params).toContain("O'Brien");
    });

    it("treats a classic SQL-injection probe as a literal filter value, never as SQL (R2)", async () => {
      const probe = "' OR '1'='1";
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [{ field: "status", operator: "equals", value: probe }],
        }),
      });

      expect(res.status).toBe(200);
      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      // The probe reaches Postgres as one opaque bound value - it never
      // appears unescaped in the query text, and the query text itself
      // still has exactly the placeholder shape a legitimate filter would
      // produce (no extra clauses, no syntax break).
      expect(summaryQuery?.sql).not.toContain(probe);
      expect(summaryQuery?.params).toContain(probe);
      expect(summaryQuery?.sql).toContain("LOWER(tb.status::text) = LOWER(");
    });
  });

  describe("Role-based Security and Scoping (docs/specs/byoq-hardening.md R3/R4)", () => {
    it("scopes to tenant-wide for admin and agent roles, with no self-filter clause at all", async () => {
      for (const role of ["admin", "agent"]) {
        executedQueries = [];
        authState.roles = [role];
        const res = await app.request("http://localhost/reporting/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: { meta: { isScopedToUser: boolean } };
        };
        expect(body.data.meta.isScopedToUser).toBe(false);

        const summaryQuery = executedQueries.find((q) =>
          q.sql.includes("total_rows"),
        );
        expect(summaryQuery?.sql).not.toContain("tb.created_by");
      }
    });

    it("restricts scope to the caller's own tickets for the user role", async () => {
      executedQueries = [];
      authState.roles = ["user"];
      authState.userId = "user-abc-123";
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { isScopedToUser: boolean } };
      };
      expect(body.data.meta.isScopedToUser).toBe(true);

      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("(tb.created_by = ");
      expect(summaryQuery?.sql).toContain(" OR tb.assigned_to = ");
      expect(summaryQuery?.sql).not.toContain("user-abc-123");
      expect(summaryQuery?.params).toContain("user-abc-123");
      // The self-filter is shared by all three queries (R4's third check),
      // not just the summary - confirmed by checking the rows query too.
      const rowsQuery = executedQueries.find(
        (q) =>
          q.sql.includes("tb.instance_id") && !q.sql.includes("total_rows"),
      );
      expect(rowsQuery?.sql).toContain("(tb.created_by = ");
      expect(rowsQuery?.params).toContain("user-abc-123");
    });

    it("rejects a role outside the allowlist with 403 before running any query (R3)", async () => {
      executedQueries = [];
      authState.roles = ["customer"];
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(403);
      expect(executedQueries).toHaveLength(0);
    });

    it("ignores a scope-like field in the request body for the user role - nothing overrides the self-filter", async () => {
      // There is no real `scope` field (dropped per the spec's revision
      // history), but the point still needs a live check: a lower-privileged
      // caller cannot widen their own results via anything in the request
      // body, including a field that doesn't officially exist.
      executedQueries = [];
      authState.roles = ["user"];
      authState.userId = "user-abc-123";
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "org" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { meta: { isScopedToUser: boolean } };
      };
      expect(body.data.meta.isScopedToUser).toBe(true);
      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.params).toContain("user-abc-123");
    });
  });

  describe("sla_margin measure correctness (docs/specs/byoq-hardening.md R1)", () => {
    it("aggregates the real sla_margin_hours column, not the old placeholder", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "sla_margin", operation: "average" }),
      });

      expect(res.status).toBe(200);
      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("AVG(tb.sla_margin_hours)");
      // The old bug: measureCol fell through to the literal "1" for this
      // measure, so the aggregate had nothing to do with SLA margin at all.
      expect(summaryQuery?.sql).not.toContain("AVG(1)");
    });

    it("has ticket_base expose sla_margin_hours from workflow_states.sla_hours", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "sla_margin", operation: "sum" }),
      });

      expect(res.status).toBe(200);
      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).toContain("ws.sla_hours");
      expect(summaryQuery?.sql).toContain("sla_margin_hours");
    });

    it("reports an absent measurement as absent, never as zero", async () => {
      // Measured on a real database: no workflow state that tickets occupy
      // sets `sla_hours`, so sla_margin_hours is NULL for every row and the
      // aggregate comes back NULL. Coalescing that to 0 produced a confident
      // "0 hrs" — the same class of fabricated number B1 was raised for, just
      // a different fabricated value.
      mockSummaryRows = [{ aggregate_value: null, total_rows: 302 }];

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "sla_margin", operation: "average" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          summary: {
            value: number | null;
            formattedValue: string;
            totalRows: number;
          };
        };
      };
      expect(body.data.summary.value).toBeNull();
      expect(body.data.summary.formattedValue).toBe("No SLA configured");
      // Rows did match — the tickets exist, it is the measure that does not.
      expect(body.data.summary.totalRows).toBe(302);
    });

    it("does not coalesce a non-count aggregate to zero in SQL", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "sla_margin", operation: "average" }),
      });

      expect(res.status).toBe(200);
      const summaryQuery = executedQueries.find((q) =>
        q.sql.includes("total_rows"),
      );
      expect(summaryQuery?.sql).not.toContain(
        "COALESCE(AVG(tb.sla_margin_hours)::numeric, 0)",
      );
    });

    it("distinguishes no matching tickets from an unmeasurable one", async () => {
      mockSummaryRows = [{ aggregate_value: null, total_rows: 0 }];

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "sla_margin", operation: "average" }),
      });

      const body = (await res.json()) as {
        data: { summary: { value: number | null; formattedValue: string } };
      };
      expect(body.data.summary.value).toBeNull();
      expect(body.data.summary.formattedValue).toBe("No tickets match");
    });

    it("still reports a genuine zero count as zero", async () => {
      // The distinction only works if a real zero survives it. COUNT over no
      // rows is a true answer and must not be turned into "no data".
      mockSummaryRows = [{ aggregate_value: "0", total_rows: 0 }];

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "tickets", operation: "count" }),
      });

      const body = (await res.json()) as {
        data: { summary: { value: number | null; formattedValue: string } };
      };
      expect(body.data.summary.value).toBe(0);
      expect(body.data.summary.formattedValue).toBe("0 Tickets");
    });

    it("marks an unmeasurable group as absent rather than a zero bar", async () => {
      mockSummaryRows = [{ aggregate_value: null, total_rows: 10 }];
      mockGroupRows = [
        {
          group_key: "hr",
          group_label: "HR",
          group_value: null,
          row_count: 10,
        },
      ];

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          measure: "sla_margin",
          operation: "average",
          groupBy: "department",
        }),
      });

      const body = (await res.json()) as {
        data: { groups: Array<{ value: number | null; count: number }> };
      };
      expect(body.data.groups[0]?.value).toBeNull();
      // The rows are still counted — it is the measurement that is missing.
      expect(body.data.groups[0]?.count).toBe(10);
    });

    it("rejects the removed total_hours measure with a 400 validation error", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "total_hours" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("Error response sanitization (docs/specs/byoq-hardening.md R5)", () => {
    it("never returns raw driver error text to the client", async () => {
      const dbModule = await import("@platform/db");
      const withTenantContextMock = vi.mocked(dbModule.withTenantContext);
      withTenantContextMock.mockImplementationOnce(() => {
        throw new Error(
          'column "totally_secret_internal_column" does not exist at character 42',
        );
      });

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("QUERY_EXECUTION_ERROR");
      expect(body.message).not.toContain("totally_secret_internal_column");
      expect(body.message).not.toContain("character 42");
    });
  });

  describe("Audit logging (docs/specs/byoq-hardening.md, query-cost bounds follow-up)", () => {
    it("writes a reporting.query_executed audit entry on success", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ measure: "sla_margin", operation: "average" }),
      });

      expect(res.status).toBe(200);
      expect(writeAuditEntryMock).toHaveBeenCalledTimes(1);
      const [, entry] = writeAuditEntryMock.mock.calls[0] as [
        unknown,
        {
          action: string;
          resourceType: string;
          actorId: string;
          metadata: Record<string, unknown>;
        },
      ];
      expect(entry.action).toBe("reporting.query_executed");
      expect(entry.resourceType).toBe("reporting");
      expect(entry.actorId).toBe("user-123");
      expect(entry.metadata).toMatchObject({
        measure: "sla_margin",
        operation: "average",
      });
    });

    it("writes a reporting.query_failed audit entry on error, distinct from the executed action", async () => {
      const dbModule = await import("@platform/db");
      const withTenantContextMock = vi.mocked(dbModule.withTenantContext);
      withTenantContextMock.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(500);
      expect(writeAuditEntryMock).toHaveBeenCalledTimes(1);
      const [, entry] = writeAuditEntryMock.mock.calls[0] as [
        unknown,
        { action: string },
      ];
      expect(entry.action).toBe("reporting.query_failed");
    });

    it("classifies an API-key caller's actorType as api_key, not user", async () => {
      authState.userId = "apikey:abc123";
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const [, entry] = writeAuditEntryMock.mock.calls[0] as [
        unknown,
        { actorType: string },
      ];
      expect(entry.actorType).toBe("api_key");
    });

    it("a failing audit write never fails the underlying query response", async () => {
      writeAuditEntryMock.mockRejectedValueOnce(
        new Error("audit table unavailable"),
      );

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("Query-cost bounds (docs/specs/byoq-hardening.md follow-up)", () => {
    it("rejects more than 20 filters with a 400 validation error", async () => {
      const filters = Array.from({ length: 21 }, () => ({
        field: "status" as const,
        operator: "equals" as const,
        value: "open",
      }));

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters }),
      });

      expect(res.status).toBe(400);
    });

    it("accepts exactly 20 filters", async () => {
      const filters = Array.from({ length: 20 }, () => ({
        field: "status" as const,
        operator: "equals" as const,
        value: "open",
      }));

      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters }),
      });

      expect(res.status).toBe(200);
    });

    it("sets a per-transaction statement_timeout before running any query", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const timeoutQuery = executedQueries.find((q) =>
        q.sql.includes("SET LOCAL statement_timeout"),
      );
      expect(timeoutQuery).toBeDefined();
    });
  });

  describe("Validation & Error Handling", () => {
    it("rejects invalid filter field with 400 validation error", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters: [
            {
              field: "invalid_secret_column",
              operator: "equals",
              value: "test",
            },
          ],
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid operation with 400 validation error", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "unsupported_math_op",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid limit exceeding 500 with 400 validation error", async () => {
      const res = await app.request("http://localhost/reporting/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 1000,
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
