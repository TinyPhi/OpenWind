import { useTranslation } from "react-i18next";
import React from "react";
import { SandboxRowActions } from "./sandbox-row-actions.js";
import {
  TRIAL_BADGE,
  relativeTime,
  shortId,
  trialCountdown,
  type SandboxView,
  type TrialStatus,
} from "./format.js";

type TrialFilter = "all" | TrialStatus;
type SortKey = "name" | "createdAt" | "trialEndsAt";

export interface SandboxesTableProps {
  sandboxes: SandboxView[];
  onSelect: (sandbox: SandboxView) => void;
  /** Called after a reset, delete or trial change so the dashboard can reload. */
  onActionDone: () => void;
}

// No trial sorts after every dated trial, in either direction's "latest" end.
function trialSortValue(s: SandboxView): number {
  return s.trialEndsAt ? Date.parse(s.trialEndsAt) : Number.MAX_SAFE_INTEGER;
}

/**
 * The platform admin's sandbox list. Search/filter/sort is client-side -- the list is capped
 * by R11's per-admin sandbox quota, small enough to hold in memory.
 */
export function SandboxesTable({
  sandboxes,
  onSelect,
  onActionDone,
}: SandboxesTableProps): React.ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const [trialFilter, setTrialFilter] = React.useState<TrialFilter>("all");
  const [sort, setSort] = React.useState<{ key: SortKey; asc: boolean }>({
    key: "createdAt",
    asc: false,
  });

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sandboxes.filter(
      (s) =>
        (!q || s.name.toLowerCase().includes(q) || s.id.startsWith(q)) &&
        (trialFilter === "all" || s.trialStatus === trialFilter),
    );
    const dir = sort.asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "name") return dir * a.name.localeCompare(b.name);
      if (sort.key === "trialEndsAt")
        return dir * (trialSortValue(a) - trialSortValue(b));
      return dir * (Date.parse(a.createdAt) - Date.parse(b.createdAt));
    });
  }, [sandboxes, query, trialFilter, sort]);

  function toggleSort(key: SortKey): void {
    setSort((prev) =>
      prev.key === key
        ? { key, asc: !prev.asc }
        : { key, asc: key !== "createdAt" },
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
          placeholder={t("platformAdmin.searchByNameOrId")}
          aria-label="Search sandboxes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="pa-select"
          aria-label="Filter by trial status"
          value={trialFilter}
          // The <option> values below are exactly TrialFilter's members.
          onChange={(e) => setTrialFilter(e.target.value as TrialFilter)}
        >
          <option value="all">{t("platformAdmin.anyTrialStatus")}</option>
          <option value="active">{t("platformAdmin.trialActive")}</option>
          <option value="expired">{t("platformAdmin.trialExpired")}</option>
          <option value="none">{t("platformAdmin.noTrial")}</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="pa-muted">
          {sandboxes.length === 0
            ? "No sandboxes yet."
            : "No sandboxes match these filters."}
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
                <th>
                  <button
                    type="button"
                    className="pa-sort-btn"
                    onClick={() => toggleSort("trialEndsAt")}
                  >
                    Trial {sortIndicator("trialEndsAt")}
                  </button>
                </th>
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
              {rows.map((s) => (
                <tr
                  key={s.id}
                  className="table-row-clickable"
                  onClick={() => onSelect(s)}
                >
                  <td>
                    <div className="pa-name-cell">
                      <span className="pa-name">{s.name}</span>
                      <span className="pa-id">{shortId(s.id)}</span>
                    </div>
                  </td>
                  <td>
                    <div className="pa-name-cell">
                      <span
                        className={`badge ${TRIAL_BADGE[s.trialStatus].cls}`}
                        style={{ alignSelf: "flex-start" }}
                      >
                        {TRIAL_BADGE[s.trialStatus].label}
                      </span>
                      {s.trialEndsAt && (
                        <span
                          className="pa-muted"
                          title={new Date(s.trialEndsAt).toLocaleString()}
                        >
                          {trialCountdown(t, s.trialEndsAt)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td title={new Date(s.createdAt).toLocaleString()}>
                    {relativeTime(s.createdAt)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div className="pa-row-actions">
                      <SandboxRowActions
                        tenantId={s.id}
                        tenantName={s.name}
                        trialEndsAt={s.trialEndsAt}
                        logo={s.logo}
                        onDone={onActionDone}
                      />
                    </div>
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
