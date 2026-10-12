import React from "react";
import { SandboxRowActions } from "./sandbox-row-actions.js";
import {
  TRIAL_BADGE,
  relativeTime,
  shortId,
  type TenantView,
  type TrialStatus,
} from "./format.js";

type TypeFilter = "all" | "sandbox" | "customer";
type TrialFilter = "all" | TrialStatus;
type SortKey = "name" | "createdAt";

export interface TenantsTableProps {
  tenants: TenantView[];
  onSelect: (tenant: TenantView) => void;
  /** Called after a sandbox reset/delete so the dashboard can reload. */
  onActionDone: () => void;
}

/**
 * Every tenant (spec R2, amended 2026-10-12). Search/filter/sort is client-side -- the list
 * is the whole tenant registry, small enough to hold in memory. Reset/delete render only on
 * sandbox rows; the routes refuse a non-sandbox tenant regardless (404).
 */
export function TenantsTable({
  tenants,
  onSelect,
  onActionDone,
}: TenantsTableProps): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>("all");
  const [trialFilter, setTrialFilter] = React.useState<TrialFilter>("all");
  const [sort, setSort] = React.useState<{ key: SortKey; asc: boolean }>({
    key: "createdAt",
    asc: false,
  });

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = tenants.filter(
      (t) =>
        (!q || t.name.toLowerCase().includes(q) || t.id.startsWith(q)) &&
        (typeFilter === "all" || t.isSandbox === (typeFilter === "sandbox")) &&
        (trialFilter === "all" || t.trialStatus === trialFilter),
    );
    const dir = sort.asc ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sort.key === "name"
        ? dir * a.name.localeCompare(b.name)
        : dir * (Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    );
  }, [tenants, query, typeFilter, trialFilter, sort]);

  function toggleSort(key: SortKey): void {
    setSort((prev) =>
      prev.key === key ? { key, asc: !prev.asc } : { key, asc: key === "name" },
    );
  }

  function sortIndicator(key: SortKey): string {
    if (sort.key !== key) return "";
    return sort.asc ? "▲" : "▼";
  }

  return (
    <div>
      <div className="pa-toolbar">
        <input
          className="form-input"
          type="search"
          placeholder="Search by name or id…"
          aria-label="Search tenants"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="pa-select"
          aria-label="Filter by type"
          value={typeFilter}
          // The <option> values below are exactly TypeFilter's members.
          onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
        >
          <option value="all">All types</option>
          <option value="sandbox">Sandboxes</option>
          <option value="customer">Customers</option>
        </select>
        <select
          className="pa-select"
          aria-label="Filter by trial status"
          value={trialFilter}
          // The <option> values below are exactly TrialFilter's members.
          onChange={(e) => setTrialFilter(e.target.value as TrialFilter)}
        >
          <option value="all">Any trial status</option>
          <option value="active">Trial active</option>
          <option value="expired">Trial expired</option>
          <option value="none">No trial</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="pa-muted">
          {tenants.length === 0
            ? "No tenants yet."
            : "No tenants match these filters."}
        </p>
      ) : (
        <div className="pa-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  <button
                    type="button"
                    className="pa-sort-btn"
                    onClick={() => toggleSort("name")}
                  >
                    Name {sortIndicator("name")}
                  </button>
                </th>
                <th>Type</th>
                <th>Trial</th>
                <th>
                  <button
                    type="button"
                    className="pa-sort-btn"
                    onClick={() => toggleSort("createdAt")}
                  >
                    Created {sortIndicator("createdAt")}
                  </button>
                </th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  className="table-row-clickable"
                  onClick={() => onSelect(t)}
                >
                  <td>
                    <div className="pa-name-cell">
                      <span className="pa-name">{t.name}</span>
                      <span className="pa-id">{shortId(t.id)}</span>
                    </div>
                  </td>
                  <td>
                    <span
                      className={`badge ${t.isSandbox ? "badge-primary" : "badge-muted"}`}
                    >
                      {t.isSandbox ? "Sandbox" : "Customer"}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${TRIAL_BADGE[t.trialStatus].cls}`}>
                      {TRIAL_BADGE[t.trialStatus].label}
                    </span>
                  </td>
                  <td title={new Date(t.createdAt).toLocaleString()}>
                    {relativeTime(t.createdAt)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {t.isSandbox && (
                      <div className="pa-row-actions">
                        <SandboxRowActions
                          tenantId={t.id}
                          tenantName={t.name}
                          onDone={onActionDone}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
