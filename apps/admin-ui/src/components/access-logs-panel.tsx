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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Real Previous/Next pagination, 20/page, newest first -- built on top of
  // the backend's own cursor pagination rather than SQL OFFSET (a known
  // perf cliff on a growing audit-log table). pageCursors[i] is the cursor
  // used to fetch page i+1 (pageCursors[0] is always undefined, page 1 has
  // no cursor); pageIndex is the 0-based current page. Going back re-fetches
  // page pageIndex-1 with its already-known cursor rather than caching
  // page contents, so a page revisited after Apply-filters-elsewhere always
  // shows current data.
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [paginating, setPaginating] = useState(false);

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
    setPageCursors([undefined]);
    setPageIndex(0);
    listThirdPartyAccessLogs(nextFilters)
      .then((res) => {
        setLogs(res.data);
        setNextCursor(res.nextCursor);
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

  function goToPage(newIndex: number, cursor: string | undefined): void {
    setPaginating(true);
    listThirdPartyAccessLogs({ ...appliedFilters, cursor })
      .then((res) => {
        setLogs(res.data);
        setNextCursor(res.nextCursor);
        setPageIndex(newIndex);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof Error ? err.message : "Failed to load access logs",
        ),
      )
      .finally(() => setPaginating(false));
  }

  function goNext(): void {
    if (!nextCursor) return;
    const newIndex = pageIndex + 1;
    setPageCursors((prev) => [...prev.slice(0, newIndex), nextCursor]);
    goToPage(newIndex, nextCursor);
  }

  function goPrev(): void {
    if (pageIndex === 0) return;
    const newIndex = pageIndex - 1;
    goToPage(newIndex, pageCursors[newIndex]);
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
            <label className="form-label">Type</label>
            <select
              className="form-input"
              value={filters.type ?? ""}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  type:
                    e.target.value === ""
                      ? undefined
                      : (e.target.value as "read" | "write"),
                }))
              }
            >
              <option value="">Any</option>
              <option value="read">Read</option>
              <option value="write">Write</option>
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
                {[
                  "",
                  "Application",
                  "Person",
                  "Ticket",
                  "Type",
                  "Action",
                  "When",
                ].map((h) => (
                  <TableHead
                    key={h}
                    style={{ padding: "10px 16px", whiteSpace: "nowrap" }}
                  >
                    {h}
                  </TableHead>
                ))}
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
                    {log.ticketId ? (
                      <button
                        type="button"
                        onClick={() => openTicket(log.ticketId as string)}
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
                    ) : (
                      // Phase F follow-up's non-ticket read actions
                      // (workflow list, workflow-fields describe, tenant-
                      // wide workflow list) have no single ticket to link --
                      // shown as their resourceType instead of a blank cell.
                      <span style={{ color: TOKENS.textMuted }}>
                        ({log.resourceType})
                      </span>
                    )}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "11px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: "20px",
                        fontWeight: 500,
                        background:
                          log.type === "write"
                            ? "rgba(139, 92, 246, 0.15)"
                            : "rgba(59, 130, 246, 0.15)",
                        color: log.type === "write" ? "#8b5cf6" : "#3b82f6",
                      }}
                    >
                      {log.type === "write" ? "Write" : "Read"}
                    </span>
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
              Page {pageIndex + 1} · {logs.length} entr
              {logs.length !== 1 ? "ies" : "y"}
            </span>
            <div style={{ display: "flex", gap: "8px" }}>
              <Button
                type="button"
                variant="secondary"
                onClick={goPrev}
                disabled={pageIndex === 0 || paginating}
              >
                ← Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={goNext}
                disabled={!nextCursor || paginating}
              >
                {paginating ? "Loading…" : "Next →"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
