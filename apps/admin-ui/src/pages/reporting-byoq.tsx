import React, { useCallback, useEffect, useMemo, useState } from "react";
import { TOKENS, useHoverStyle } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../lib/api.js";

export type FilterOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "less_than"
  | "contains"
  | "is_empty"
  | "is_not_empty"
  | "between";

export type FilterField =
  | "status"
  | "priority"
  | "assignee"
  | "department"
  | "category"
  | "createdAt"
  | "resolvedAt";

export type FilterRuleState = {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
  dateRange?: { from?: string; to?: string };
};

export type BYORowData = {
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

export type BYOGroupData = {
  key: string;
  label: string;
  /** null when this group has nothing to measure. */
  value: number | null;
  percentage: number;
  count: number;
};

export type BYOResponseData = {
  summary: {
    measure: string;
    operation: string;
    /** null when there is nothing to measure; formattedValue says why. */
    value: number | null;
    formattedValue: string;
    totalRows: number;
  };
  groups: BYOGroupData[];
  rows: BYORowData[];
  meta: {
    groupBy: string;
    isScopedToUser: boolean;
    appliedFiltersCount: number;
  };
};

type OrgUser = {
  userId: string;
  displayName: string;
  email: string;
};

const FIELD_OPTIONS: { value: FilterField; label: string }[] = [
  { value: "status", label: "Ticket Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "department", label: "Department" },
  { value: "category", label: "Category" },
  { value: "createdAt", label: "Created Date" },
  { value: "resolvedAt", label: "Resolved Date" },
];

const OPERATION_OPTIONS = [
  { value: "count", label: "Count" },
  { value: "average", label: "Average" },
  { value: "sum", label: "Sum" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
  { value: "median", label: "Median" },
];

const GROUP_BY_OPTIONS = [
  { value: "none", label: "None (Overall Metric)" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "department", label: "Department" },
  { value: "assignee", label: "Assignee" },
  { value: "category", label: "Category" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const OPERATOR_OPTIONS: { value: FilterOperator; label: string }[] = [
  { value: "equals", label: "Equals" },
  { value: "not_equals", label: "Not equals" },
  { value: "greater_than", label: "Greater than" },
  { value: "less_than", label: "Less than" },
  { value: "contains", label: "Contains" },
  { value: "is_empty", label: "Is empty" },
  { value: "is_not_empty", label: "Is not empty" },
  { value: "between", label: "Between (Dates)" },
];

const STATUS_VALUES = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "escalated", label: "Escalated" },
];

const PRIORITY_VALUES = [
  { value: "Urgent", label: "Urgent" },
  { value: "High", label: "High" },
  { value: "Medium", label: "Medium" },
  { value: "Low", label: "Low" },
];

const CHART_COLORS = [
  "hsl(211, 100%, 50%)",
  "hsl(150, 75%, 40%)",
  "hsl(35, 90%, 50%)",
  "hsl(265, 84%, 60%)",
  "hsl(340, 80%, 58%)",
  "hsl(185, 80%, 40%)",
];

export const ReportingBYOQSidebar: React.FC<{
  isOpen: boolean;
  onToggle: () => void;
  isStaff: boolean;
}> = ({ isOpen, onToggle, isStaff }) => {
  const [measure, setMeasure] = useState<string>("tickets");
  const [operation, setOperation] = useState<string>("count");
  const [groupBy, setGroupBy] = useState<string>("status");
  const [filters, setFilters] = useState<FilterRuleState[]>([]);
  const [autoRun, setAutoRun] = useState<boolean>(true);
  const [showTableModal, setShowTableModal] = useState<boolean>(false);
  const [searchFilter, setSearchFilter] = useState<string>("");

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BYOResponseData | null>(null);
  const [users, setUsers] = useState<OrgUser[]>([]);

  // Load org users for assignee filters
  useEffect(() => {
    void (async () => {
      try {
        const res = (await fetchWithAuth(`${API_URL}/users`)) as {
          data?: OrgUser[];
          users?: OrgUser[];
        };
        const list = res.data ?? res.users ?? [];
        setUsers(list);
      } catch {
        // graceful fallback
      }
    })();
  }, []);

  const runQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = {
        measure,
        operation,
        groupBy,
        filters: filters.map((f) => ({
          field: f.field,
          operator: f.operator,
          value: f.operator === "between" ? f.dateRange : f.value,
        })),
        limit: 100,
      };

      const res = (await fetchWithAuth(`${API_URL}/reporting/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })) as { data?: BYOResponseData; error?: string; message?: string };

      // `data` is absent on error responses.
      if (res.data) {
        setResult(res.data);
      } else {
        setError(res.message ?? "Failed to execute query");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error running query");
    } finally {
      setLoading(false);
    }
  }, [measure, operation, groupBy, filters]);

  // Initial and Auto-run effect
  useEffect(() => {
    if (!isOpen || !autoRun) return;
    const timer = setTimeout(() => {
      void runQuery();
    }, 250);
    return () => clearTimeout(timer);
  }, [measure, operation, groupBy, filters, autoRun, isOpen, runQuery]);

  const addFilter = (): void => {
    setFilters((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).slice(2),
        field: "status",
        operator: "equals",
        value: "open",
      },
    ]);
  };

  const removeFilter = (id: string): void => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const updateFilter = (
    id: string,
    updates: Partial<FilterRuleState>,
  ): void => {
    setFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...updates } : f)),
    );
  };

  const formatTitleCase = (val: string | null | undefined): string => {
    if (!val) return "-";
    const s = val.trim();
    if (s.toLowerCase() === "hr") return "HR";
    if (s.toLowerCase() === "it") return "IT";
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  };

  const resolveAssigneeName = (
    assigneeId: string | null,
    fallbackName: string,
    userList: OrgUser[],
  ): string => {
    if (!assigneeId || assigneeId === "unassigned") return "Unassigned";
    const matched = userList.find((u) => u.userId === assigneeId);
    if (matched) return matched.displayName || matched.email || assigneeId;
    return fallbackName && fallbackName !== assigneeId
      ? fallbackName
      : assigneeId;
  };

  const exportCSV = (): void => {
    if (!result?.rows.length) return;
    const headers = [
      "Ticket ID",
      "Title",
      "Status",
      "Priority",
      "Assign to",
      "Raised By",
      "Department",
      "Category",
      "Created At",
      "Resolved At",
      "Duration (Hours)",
    ];
    const rows = result.rows.map((r) => [
      `"${r.id}"`,
      `"${r.title.replace(/"/g, '""')}"`,
      `"${r.status}"`,
      `"${formatTitleCase(r.priority)}"`,
      `"${resolveAssigneeName(r.assigneeId, r.assigneeName, users)}"`,
      `"${r.raiserName}"`,
      `"${formatTitleCase(r.department)}"`,
      `"${formatTitleCase(r.category)}"`,
      `"${r.createdAt}"`,
      `"${r.resolvedAt ?? ""}"`,
      r.resolutionTimeHours ?? "",
    ]);
    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute(
      "download",
      `openwind-byoq-export-${new Date().toISOString().slice(0, 10)}.csv`,
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredRows = useMemo(() => {
    if (!result?.rows) return [];
    if (!searchFilter.trim()) return result.rows;
    const q = searchFilter.toLowerCase();
    return result.rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q) ||
        r.assigneeName.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q),
    );
  }, [result?.rows, searchFilter]);

  const runHover = useHoverStyle({
    base: { background: TOKENS.accentPrimary, color: "#fff" },
    hover: { opacity: "0.9" },
  });

  if (!isOpen) {
    return (
      <aside
        aria-label="BYOQ Collapsed Rail"
        data-testid="byoq-sidebar-collapsed"
        onClick={onToggle}
        title="Open Build Your Own Query (BYOQ) Sidebar"
        style={{
          width: 44,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: "var(--bg-secondary, rgba(255,255,255,0.03))",
          border: `1px solid ${TOKENS.borderColor}`,
          borderRadius: "var(--radius-md, 8px)",
          padding: "12px 4px",
          gap: 14,
          cursor: "pointer",
          transition: "all 0.2s ease",
          userSelect: "none",
          minHeight: 480,
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand BYOQ Sidebar"
          title="Expand BYOQ Sidebar"
          style={{
            background: TOKENS.accentPrimary,
            color: "#fff",
            border: "none",
            borderRadius: 6,
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 700,
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
          }}
        >
          ▶
        </button>

        <div
          style={{
            writingMode: "vertical-rl",
            transform: "rotate(180deg)",
            color: TOKENS.textPrimary,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.06em",
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 10,
            whiteSpace: "nowrap",
          }}
        >
          <span>⚡ BYOQ Sidebar</span>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="BYOQ Sidebar"
      data-testid="byoq-sidebar"
      style={{
        width: 350,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-secondary, rgba(255,255,255,0.03))",
        border: `1px solid ${TOKENS.borderColor}`,
        borderRadius: "var(--radius-md, 8px)",
        padding: 16,
        gap: 14,
        maxHeight: "calc(100vh - 150px)",
        overflowY: "auto",
        transition: "width 0.2s ease",
      }}
    >
      {/* Sidebar Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${TOKENS.borderColor}`,
          paddingBottom: 10,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: TOKENS.textPrimary,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>⚡ BYOQ Control Panel</span>
          </div>
          <div style={{ fontSize: 11, color: TOKENS.textMuted }}>
            {isStaff ? "🌐 Tenant-wide Scope" : "🔒 Scoped to Your Tickets"}
          </div>
        </div>

        <button
          type="button"
          onClick={onToggle}
          title="Collapse Sidebar"
          style={{
            background: "transparent",
            border: "none",
            color: TOKENS.textMuted,
            cursor: "pointer",
            fontSize: 16,
            padding: "2px 6px",
            borderRadius: 4,
          }}
        >
          ◀
        </button>
      </div>

      {/* Field / Measure */}
      <div>
        <label
          style={{
            display: "block",
            fontSize: 11,
            fontWeight: 700,
            color: TOKENS.textMuted,
            marginBottom: 4,
            textTransform: "uppercase",
          }}
        >
          Measure
        </label>
        <select
          value={measure}
          onChange={(e) => setMeasure(e.target.value)}
          style={{
            width: "100%",
            padding: "6px 8px",
            borderRadius: 6,
            border: `1px solid ${TOKENS.borderColor}`,
            background: "var(--bg-primary, #fff)",
            color: TOKENS.textPrimary,
            fontSize: 13,
          }}
        >
          <option value="tickets">Total Tickets</option>
          <option value="resolution_time">Resolution Time (Hours)</option>
          <option value="sla_margin">SLA Margin (Hours)</option>
        </select>
      </div>

      {/* Operation & Group By in 2 columns */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label
            style={{
              display: "block",
              fontSize: 11,
              fontWeight: 700,
              color: TOKENS.textMuted,
              marginBottom: 4,
              textTransform: "uppercase",
            }}
          >
            Operation
          </label>
          <select
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              borderRadius: 6,
              border: `1px solid ${TOKENS.borderColor}`,
              background: "var(--bg-primary, #fff)",
              color: TOKENS.textPrimary,
              fontSize: 13,
            }}
          >
            {OPERATION_OPTIONS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            style={{
              display: "block",
              fontSize: 11,
              fontWeight: 700,
              color: TOKENS.textMuted,
              marginBottom: 4,
              textTransform: "uppercase",
            }}
          >
            Group By
          </label>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              borderRadius: 6,
              border: `1px solid ${TOKENS.borderColor}`,
              background: "var(--bg-primary, #fff)",
              color: TOKENS.textPrimary,
              fontSize: 13,
            }}
          >
            {GROUP_BY_OPTIONS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Dynamic Filters Builder */}
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: TOKENS.textMuted,
              textTransform: "uppercase",
            }}
          >
            Filters ({filters.length})
          </span>
          <button
            type="button"
            onClick={addFilter}
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              border: `1px solid ${TOKENS.borderColor}`,
              background: "transparent",
              color: TOKENS.textPrimary,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            + Add
          </button>
        </div>

        {filters.length === 0 ? (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 6,
              border: `1px dashed ${TOKENS.borderColor}`,
              color: TOKENS.textMuted,
              fontSize: 11,
              textAlign: "center",
            }}
          >
            No filters applied
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filters.map((filter) => (
              <div
                key={filter.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "var(--bg-primary, #fff)",
                  border: `1px solid ${TOKENS.borderColor}`,
                }}
              >
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <select
                    value={filter.field}
                    onChange={(e) =>
                      updateFilter(filter.id, {
                        field: e.target.value as FilterField,
                        value: "",
                      })
                    }
                    style={{
                      flex: 1,
                      padding: "4px 6px",
                      borderRadius: 4,
                      border: `1px solid ${TOKENS.borderColor}`,
                      background: "transparent",
                      color: TOKENS.textPrimary,
                      fontSize: 12,
                    }}
                  >
                    {FIELD_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>

                  <select
                    value={filter.operator}
                    onChange={(e) =>
                      updateFilter(filter.id, {
                        operator: e.target.value as FilterOperator,
                      })
                    }
                    style={{
                      flex: 1,
                      padding: "4px 6px",
                      borderRadius: 4,
                      border: `1px solid ${TOKENS.borderColor}`,
                      background: "transparent",
                      color: TOKENS.textPrimary,
                      fontSize: 12,
                    }}
                  >
                    {OPERATOR_OPTIONS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => removeFilter(filter.id)}
                    title="Remove filter"
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "hsl(0, 80%, 60%)",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: 700,
                    }}
                  >
                    &times;
                  </button>
                </div>

                {/* Dynamic Value selector */}
                {filter.operator !== "is_empty" &&
                  filter.operator !== "is_not_empty" && (
                    <div>
                      {filter.field === "status" && (
                        <select
                          value={filter.value}
                          onChange={(e) =>
                            updateFilter(filter.id, { value: e.target.value })
                          }
                          style={{
                            width: "100%",
                            padding: "4px 6px",
                            borderRadius: 4,
                            border: `1px solid ${TOKENS.borderColor}`,
                            background: "transparent",
                            color: TOKENS.textPrimary,
                            fontSize: 12,
                          }}
                        >
                          <option value="">Select Status...</option>
                          {STATUS_VALUES.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      )}

                      {filter.field === "priority" && (
                        <select
                          value={filter.value}
                          onChange={(e) =>
                            updateFilter(filter.id, { value: e.target.value })
                          }
                          style={{
                            width: "100%",
                            padding: "4px 6px",
                            borderRadius: 4,
                            border: `1px solid ${TOKENS.borderColor}`,
                            background: "transparent",
                            color: TOKENS.textPrimary,
                            fontSize: 12,
                          }}
                        >
                          <option value="">Select Priority...</option>
                          {PRIORITY_VALUES.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      )}

                      {filter.field === "assignee" && (
                        <select
                          value={filter.value}
                          onChange={(e) =>
                            updateFilter(filter.id, { value: e.target.value })
                          }
                          style={{
                            width: "100%",
                            padding: "4px 6px",
                            borderRadius: 4,
                            border: `1px solid ${TOKENS.borderColor}`,
                            background: "transparent",
                            color: TOKENS.textPrimary,
                            fontSize: 12,
                          }}
                        >
                          <option value="">Select Assignee...</option>
                          <option value="unassigned">Unassigned</option>
                          {users.map((u) => (
                            <option key={u.userId} value={u.userId}>
                              {u.displayName || u.email}
                            </option>
                          ))}
                        </select>
                      )}

                      {filter.field !== "status" &&
                        filter.field !== "priority" &&
                        filter.field !== "assignee" && (
                          <input
                            type={
                              filter.field === "createdAt" ||
                              filter.field === "resolvedAt"
                                ? "date"
                                : "text"
                            }
                            value={filter.value}
                            placeholder={`Enter ${filter.field}...`}
                            onChange={(e) =>
                              updateFilter(filter.id, { value: e.target.value })
                            }
                            style={{
                              width: "100%",
                              padding: "4px 6px",
                              borderRadius: 4,
                              border: `1px solid ${TOKENS.borderColor}`,
                              background: "transparent",
                              color: TOKENS.textPrimary,
                              fontSize: 12,
                            }}
                          />
                        )}
                    </div>
                  )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action Controls */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          type="button"
          onClick={() => void runQuery()}
          disabled={loading}
          style={{
            width: "100%",
            padding: "8px",
            borderRadius: 6,
            border: "none",
            fontWeight: 600,
            fontSize: 13,
            cursor: loading ? "not-allowed" : "pointer",
            ...runHover.style,
          }}
          onMouseEnter={runHover.onMouseEnter}
          onMouseLeave={runHover.onMouseLeave}
        >
          {loading ? "Running..." : "▶ Apply BYOQ Query"}
        </button>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: TOKENS.textMuted,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={autoRun}
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            <span>Auto-run</span>
          </label>

          <button
            type="button"
            onClick={exportCSV}
            disabled={!result?.rows.length}
            style={{
              padding: "3px 8px",
              borderRadius: 4,
              border: `1px solid ${TOKENS.borderColor}`,
              background: "transparent",
              color: TOKENS.textPrimary,
              fontSize: 11,
              fontWeight: 600,
              cursor: result?.rows.length ? "pointer" : "not-allowed",
              opacity: result?.rows.length ? 1 : 0.5,
            }}
          >
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div
          style={{
            padding: "8px",
            borderRadius: 6,
            background: "hsla(0, 80%, 50%, 0.1)",
            border: "1px solid hsla(0, 80%, 50%, 0.3)",
            color: "hsl(0, 80%, 65%)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* Live Result Summary & Mini Distribution */}
      {result && (
        <div
          style={{
            borderTop: `1px solid ${TOKENS.borderColor}`,
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {/* Mini KPI Card */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 6,
              background: "var(--bg-primary, #fff)",
              border: `1px solid ${TOKENS.borderColor}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: TOKENS.textMuted,
                  textTransform: "uppercase",
                }}
              >
                {result.summary.operation} Result
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: TOKENS.textPrimary,
                }}
              >
                {result.summary.formattedValue}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: TOKENS.textMuted,
                  textTransform: "uppercase",
                }}
              >
                Matches
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: TOKENS.textPrimary,
                }}
              >
                {result.summary.totalRows}
              </div>
            </div>
          </div>

          {/* Mini Distribution Progress Bars */}
          {result.groups.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: TOKENS.textMuted,
                  textTransform: "uppercase",
                }}
              >
                Breakdown ({groupBy})
              </div>
              {result.groups.slice(0, 6).map((g, idx) => {
                const color = CHART_COLORS[idx % CHART_COLORS.length];
                return (
                  <div
                    key={g.key}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      fontSize: 11,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          color: TOKENS.textPrimary,
                          maxWidth: 160,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {g.label}
                      </span>
                      <span style={{ color: TOKENS.textMuted }}>
                        {g.value === null
                          ? "no data"
                          : `${g.value} (${g.percentage}%)`}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 3,
                        background:
                          "var(--border-color, rgba(255,255,255,0.1))",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.min(100, Math.max(3, g.percentage))}%`,
                          background: color,
                          borderRadius: 3,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* View Details Button */}
          <button
            type="button"
            onClick={() => setShowTableModal(true)}
            style={{
              padding: "6px",
              borderRadius: 6,
              border: `1px solid ${TOKENS.borderColor}`,
              background: "transparent",
              color: TOKENS.accentPrimary,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              textAlign: "center",
            }}
          >
            🔍 View Matching Records ({result.rows.length})
          </button>
        </div>
      )}

      {/* Record List Modal Drawer */}
      {showTableModal && result && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setShowTableModal(false)}
        >
          <div
            style={{
              background: "var(--bg-primary, #fff)",
              borderRadius: 8,
              border: `1px solid ${TOKENS.borderColor}`,
              width: "90%",
              maxWidth: 900,
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: "16px 20px",
                borderBottom: `1px solid ${TOKENS.borderColor}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                BYOQ Matching Records ({filteredRows.length})
              </h3>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  type="text"
                  placeholder="Filter records..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: 4,
                    border: `1px solid ${TOKENS.borderColor}`,
                    background: "transparent",
                    color: TOKENS.textPrimary,
                    fontSize: 12,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowTableModal(false)}
                  style={{
                    border: "none",
                    background: "transparent",
                    fontSize: 18,
                    cursor: "pointer",
                    color: TOKENS.textMuted,
                  }}
                >
                  &times;
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr
                    style={{ borderBottom: `1px solid ${TOKENS.borderColor}` }}
                  >
                    <th style={{ padding: 8, textAlign: "left" }}>Title</th>
                    <th style={{ padding: 8, textAlign: "left" }}>Status</th>
                    <th style={{ padding: 8, textAlign: "left" }}>Priority</th>
                    <th style={{ padding: 8, textAlign: "left" }}>Assign to</th>
                    <th style={{ padding: 8, textAlign: "left" }}>
                      Department
                    </th>
                    <th style={{ padding: 8, textAlign: "left" }}>Created</th>
                    <th style={{ padding: 8, textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((r) => (
                    <tr
                      key={r.id}
                      style={{
                        borderBottom: `1px solid ${TOKENS.borderColor}`,
                      }}
                    >
                      <td style={{ padding: 8, fontWeight: 600 }}>{r.title}</td>
                      <td style={{ padding: 8 }}>{r.status}</td>
                      <td style={{ padding: 8 }}>
                        {formatTitleCase(r.priority)}
                      </td>
                      <td style={{ padding: 8 }}>
                        {resolveAssigneeName(
                          r.assigneeId,
                          r.assigneeName,
                          users,
                        )}
                      </td>
                      <td style={{ padding: 8 }}>
                        {formatTitleCase(r.department)}
                      </td>
                      <td style={{ padding: 8 }}>
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: 8, textAlign: "right" }}>
                        <a
                          href={`/records/record/${r.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: TOKENS.accentPrimary,
                            textDecoration: "none",
                            fontWeight: 600,
                          }}
                        >
                          Open &rarr;
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default ReportingBYOQSidebar;
