import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { useEntityTypes, toTypeSlug } from "../entity-type-context.js";

interface OrgUser {
  userId: string;
  displayName: string;
}

export interface AccessLogsPanelProps {
  /**
   * Admin-UI API Keys detail view — locks the Application filter to every
   * key id belonging to one "application" (a rotation can span multiple
   * key rows). The field is hidden (not just disabled) since there's
   * nothing meaningful for the admin to edit it to in that context. The
   * standalone Access Logs page omits this — its Application field stays a
   * free-text single-id filter, unchanged from before this component was
   * extracted.
   */
  lockedApplicationIds?: string[] | undefined;
}

export function AccessLogsPanel({
  lockedApplicationIds,
}: AccessLogsPanelProps): React.ReactElement {
  const navigate = useNavigate();
  const { getTypeById } = useEntityTypes();
  const baseFilters: AccessLogFilters = lockedApplicationIds
    ? { application: lockedApplicationIds }
    : {};

  // Acting-person ids in the log are Zitadel user ids, not names — resolved
  // against the org member list (same source as pages/users.tsx) so the
  // table reads as a human name instead of a raw numeric id.
  const [usersById, setUsersById] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    fetchWithAuth(`${API_URL}/users`)
      .then((res) => {
        const users = (res as { data?: OrgUser[] }).data ?? [];
        setUsersById(new Map(users.map((u) => [u.userId, u.displayName])));
      })
      .catch(() => undefined);
  }, []);

  // `filters` is the live, in-progress editing state (updated on every
  // keystroke). `appliedFilters` is what the last successful load actually
  // used — loadMore() must page through THAT result set, not whatever the
  // admin has since typed into the form but not yet applied (PR #489
  // review, F-03: mixing the two silently returned data belonging to
  // neither the old nor the new filter combination).
  const [filters, setFilters] = useState<AccessLogFilters>(baseFilters);
  const [appliedFilters, setAppliedFilters] =
    useState<AccessLogFilters>(baseFilters);
  const [logs, setLogs] = useState<AccessLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolved lazily per row on click, not prefetched for every log entry —
  // the audit log only stores the ticket's instance id, not its entity
  // type, so the type slug the /records/:typeSlug/:id route needs comes
  // from a follow-up GET /entities/:id lookup.
  const [resolvingTicketId, setResolvingTicketId] = useState<string | null>(
    null,
  );
  function openTicket(ticketId: string): void {
    setResolvingTicketId(ticketId);
    fetchWithAuth(`${API_URL}/entities/${ticketId}`)
      .then((res) => {
        const entityTypeId = (res as { data?: { entityTypeId?: string } }).data
          ?.entityTypeId;
        const type = entityTypeId ? getTypeById(entityTypeId) : undefined;
        if (!type) {
          setError("Could not resolve this ticket's record type.");
          return;
        }
        navigate(`/records/${toTypeSlug(type.name)}/${ticketId}`);
      })
      .catch(() => setError("Failed to open ticket — it may be deleted."))
      .finally(() => setResolvingTicketId(null));
  }

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
    // "Apply filters" button, not on every keystroke. baseFilters is
    // derived from a prop that's effectively static per mount (the detail
    // page it's used on doesn't change which application it's showing
    // without remounting).
    load(baseFilters);
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
          {!lockedApplicationIds && (
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Application (key id)</label>
              <input
                className="form-input"
                placeholder="api key uuid"
                value={
                  typeof filters.application === "string"
                    ? filters.application
                    : ""
                }
                onChange={(e) =>
                  setFilters((f) => ({ ...f, application: e.target.value }))
                }
              />
            </div>
          )}
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
              setFilters(baseFilters);
              load(baseFilters);
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
                    title={log.actingPersonId ?? undefined}
                  >
                    {log.actingPersonId
                      ? (usersById.get(log.actingPersonId) ??
                        log.actingPersonId)
                      : "—"}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "12px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => openTicket(log.ticketId)}
                      disabled={resolvingTicketId === log.ticketId}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        font: "inherit",
                        fontFamily: "monospace",
                        color: TOKENS.accentPrimary,
                        cursor:
                          resolvingTicketId === log.ticketId
                            ? "wait"
                            : "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      {resolvingTicketId === log.ticketId
                        ? "Opening…"
                        : log.ticketId}
                    </button>
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
