import React, { useEffect, useState } from "react";
import {
  Button,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TOKENS,
} from "@platform/ui";
import {
  listThirdPartyAccessLogs,
  type AccessLogRow,
  type AccessLogFilters,
} from "../lib/third-party-access-logs-client.js";
import { relativeTime } from "../lib/format.js";

const EMPTY_FILTERS: AccessLogFilters = {};

export function ThirdPartyAccessLogsPage(): React.ReactElement {
  // `filters` is the live, in-progress editing state (updated on every
  // keystroke). `appliedFilters` is what the last successful load actually
  // used — loadMore() must page through THAT result set, not whatever the
  // admin has since typed into the form but not yet applied (PR #489
  // review, F-03: mixing the two silently returned data belonging to
  // neither the old nor the new filter combination).
  const [filters, setFilters] = useState<AccessLogFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<AccessLogFilters>(EMPTY_FILTERS);
  const [logs, setLogs] = useState<AccessLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(nextFilters: AccessLogFilters): void {
    setLoading(true);
    setError(null);
    setAppliedFilters(nextFilters);
    listThirdPartyAccessLogs(nextFilters)
      .then((res) => {
        setLogs(res.data);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof Error ? err.message : "Failed to load access logs",
        ),
      )
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    // Only on mount — filter changes are applied explicitly via the
    // "Apply filters" button, not on every keystroke.
    load(EMPTY_FILTERS);
  }, []);

  function loadMore(): void {
    if (!cursor) return;
    setLoadingMore(true);
    listThirdPartyAccessLogs({ ...appliedFilters, cursor })
      .then((res) => {
        setLogs((prev) => [...prev, ...res.data]);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof Error ? err.message : "Failed to load access logs",
        ),
      )
      .finally(() => setLoadingMore(false));
  }

  return (
    <div>
      <div style={{ marginBottom: "24px" }}>
        <h2 className="page-title">Third-Party API Access Logs</h2>
        <p className="page-subtitle">
          Every third-party application request/attempt against a ticket —
          application, acting person, action, allowed vs. denied. The primary
          place to investigate a connected application's behavior, separate from
          the ticket timeline itself.
        </p>
      </div>

      <div
        className="alert"
        style={{
          marginBottom: "16px",
          background: "hsla(38, 92%, 50%, 0.12)",
          border: "1px solid hsl(38, 92%, 50%)",
          color: TOKENS.textPrimary,
          fontSize: "13px",
          padding: "10px 14px",
          borderRadius: TOKENS.radiusSm,
        }}
      >
        <strong>Known residual risk:</strong> the volume-spike misuse alert is
        threshold-based, not behavioral — sustained abuse that stays just under
        the threshold will not trigger a proactive alert. This log remains the
        way to manually spot that pattern.
      </div>

      <div
        className="data-panel"
        style={{ padding: "16px", marginBottom: "16px" }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "12px",
          }}
        >
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Application (key id)</label>
            <input
              className="form-input"
              placeholder="api key uuid"
              value={filters.application ?? ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, application: e.target.value }))
              }
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Person</label>
            <input
              className="form-input"
              placeholder="acting person id"
              value={filters.personId ?? ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, personId: e.target.value }))
              }
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Ticket</label>
            <input
              className="form-input"
              placeholder="ticket uuid"
              value={filters.ticketId ?? ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, ticketId: e.target.value }))
              }
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Outcome</label>
            <select
              className="form-input"
              value={filters.outcome ?? ""}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  outcome:
                    e.target.value === ""
                      ? undefined
                      : (e.target.value as "allowed" | "denied"),
                }))
              }
            >
              <option value="">Any</option>
              <option value="allowed">Allowed</option>
              <option value="denied">Denied</option>
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">From</label>
            <input
              className="form-input"
              type="datetime-local"
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  from: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : undefined,
                }))
              }
            />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">To</label>
            <input
              className="form-input"
              type="datetime-local"
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  to: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : undefined,
                }))
              }
            />
          </div>
        </div>
        <div
          style={{
            marginTop: "12px",
            display: "flex",
            gap: "8px",
            justifyContent: "flex-end",
          }}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              load(EMPTY_FILTERS);
            }}
          >
            Clear
          </Button>
          <Button type="button" onClick={() => load(filters)}>
            Apply filters
          </Button>
        </div>
      </div>

      {loading && (
        <div className="loading-center">
          <div className="spinner" />
          <span className="loader-text">Loading access logs…</span>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && logs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <div className="empty-state-title">No matching requests</div>
          <div className="empty-state-subtitle">
            No third-party API activity matches the current filters.
          </div>
        </div>
      )}

      {!loading && !error && logs.length > 0 && (
        <div
          className="data-panel"
          style={{ overflowX: "auto", overflowY: "hidden" }}
        >
          <Table scroll={false}>
            <TableHeader>
              <TableRow>
                {["", "Application", "Person", "Ticket", "Action", "When"].map(
                  (h) => (
                    <TableHead
                      key={h}
                      style={{ padding: "10px 16px", whiteSpace: "nowrap" }}
                    >
                      {h}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell style={{ padding: "12px 16px", width: "1%" }}>
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background:
                          log.outcome === "denied"
                            ? TOKENS.danger
                            : "var(--success, hsl(142, 60%, 40%))",
                      }}
                      title={log.outcome === "denied" ? "Denied" : "Allowed"}
                    />
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: TOKENS.textPrimary,
                      whiteSpace: "nowrap",
                    }}
                    title={log.applicationKeyId}
                  >
                    {log.applicationName ?? "(unknown application)"}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: TOKENS.textSecondary,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.actingPersonId ?? "—"}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "12px",
                      color: TOKENS.textSecondary,
                      fontFamily: "monospace",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.ticketId}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: TOKENS.textPrimary,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.action}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: TOKENS.textSecondary,
                      whiteSpace: "nowrap",
                    }}
                    title={new Date(log.timestamp).toLocaleString()}
                  >
                    {relativeTime(log.timestamp)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div
            style={{
              padding: "10px 16px",
              fontSize: "12px",
              color: TOKENS.textMuted,
              borderTop: `1px solid ${TOKENS.borderColor}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {logs.length} entr{logs.length !== 1 ? "ies" : "y"}
            </span>
            {cursor && (
              <Button
                type="button"
                variant="secondary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
