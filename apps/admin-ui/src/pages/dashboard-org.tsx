import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { useHoverStyle } from "@platform/ui";
import {
  Card,
  SectionHeader,
  KpiTile,
  FilterTabs,
  Pagination,
  PAGE_SIZE,
  type TicketFilter,
} from "./dashboard.js";

// ── My Org View (docs/specs/my-org-view.md) ───────────────────────────────────
// Aggregate ticket/SLA/team view across a manager's own tickets + every direct and
// indirect report in the org tree (GET /dashboard/org-view). Gated on having reports,
// never on platform role: the API answers hasReports:false for everyone else and the
// dashboard hides the toggle.
//
// Rendered INLINE on the dashboard via a pill toggle, not as a separate routed page --
// `OrgDashboardBody` is the presentational piece dashboard.tsx mounts directly, sharing
// its single GET /dashboard/org-view fetch. `useOrgView`/`OrgDashboardBody` are exported
// for that purpose.
//
// Visual language reuses dashboard.tsx's Card/SectionHeader/KpiTile primitives and the
// same hsl(...) accent palette (blue=tickets, red=overdue, pink=SLA risk, purple=workload,
// teal=team).

export interface WorkflowStateCount {
  stateId: string;
  stateName: string;
  count: number;
}
export interface WorkflowBreakdown {
  workflowId: string;
  workflowName: string;
  counts: WorkflowStateCount[];
  total: number;
}
export interface TicketSummary {
  entityId: string;
  entityTypeId: string;
  entityTypeName: string;
  workflowId: string | null;
  workflowName: string | null;
  stateName: string;
  title: string;
  dueDate: string | null;
  isOverdue: boolean;
  assignedTo: string | null;
  assignedToName?: string | null;
}
export interface SlaRiskItem {
  entityId: string;
  entityTypeId: string;
  entityTypeName: string;
  title: string;
  stateName: string;
  hoursOver: number;
}
export interface TeamMember {
  userId: string;
  name: string;
  ticketCount: number;
  overdueCount: number;
}

export interface OrgView {
  hasReports: boolean;
  truncated: boolean;
  /** Client-side only: the request failed, so the org data could not be loaded. */
  unavailable: boolean;
  workflows: WorkflowBreakdown[];
  tickets: { items: TicketSummary[]; totalQualifying: number };
  dueDates: { items: unknown[]; totalQualifying: number };
  slaRisk: { items: SlaRiskItem[]; totalQualifying: number };
  teamMembers: { items: TeamMember[] };
}

export const EMPTY_ORG_VIEW: OrgView = {
  hasReports: false,
  truncated: false,
  unavailable: false,
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
  teamMembers: { items: [] },
};

// The ordinary dashboard load performs only the cheap has-reports probe. The full payload is
// fetched once, lazily, on the first Org View selection and then retained across tab switches.
// `enabled: false` (used by the "view as subordinate" page, R9) skips both requests.
export function useOrgView(
  enabled = true,
  selected = false,
): {
  view: OrgView;
  loading: boolean;
} {
  const [view, setView] = useState<OrgView>(EMPTY_ORG_VIEW);
  const [loading, setLoading] = useState(false);
  const fullRequested = useRef(false);
  const fullRequestGeneration = useRef(0);

  useEffect(
    () => () => {
      fullRequestGeneration.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      fullRequestGeneration.current += 1;
      setView(EMPTY_ORG_VIEW);
      fullRequested.current = false;
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetchWithAuth(`${API_URL}/dashboard/org-view/has-reports`)
      .then((res) => {
        if (cancelled) return;
        const data = (res as { data?: { hasReports?: boolean } }).data;
        setView({
          ...EMPTY_ORG_VIEW,
          hasReports: data?.hasReports === true,
        });
      })
      .catch(() => {
        if (!cancelled) setView(EMPTY_ORG_VIEW);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !selected || !view.hasReports || fullRequested.current)
      return;

    const generation = fullRequestGeneration.current;
    fullRequested.current = true;
    setLoading(true);
    fetchWithAuth(`${API_URL}/dashboard/org-view`)
      .then((res) => {
        if (generation !== fullRequestGeneration.current) return;
        const data = (res as { data?: OrgView }).data;
        setView(data ?? EMPTY_ORG_VIEW);
      })
      .catch(() => {
        if (generation === fullRequestGeneration.current) {
          setView((current) => ({
            ...EMPTY_ORG_VIEW,
            hasReports: current.hasReports,
            unavailable: true,
          }));
        }
      })
      .finally(() => {
        if (generation === fullRequestGeneration.current) setLoading(false);
      });
  }, [enabled, selected, view.hasReports]);

  return { view, loading };
}

function formatHoursOver(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h over SLA`;
  return `${Math.round(hours / 24)}d over SLA`;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

// Own hover state per row (not one shared toggle for the whole table) —
// matches TicketRow's convention in dashboard.tsx.
function TeamMemberRow({ member }: { member: TeamMember }): React.ReactElement {
  const navigate = useNavigate();
  const rowHover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: "var(--bg-tertiary)" },
  });

  return (
    <tr
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
      style={rowHover.style}
    >
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        {/* "View as subordinate" (docs/specs/my-org-view.md R9) — clicking
            a team member's name opens their own dashboard, read-only.
            Authorization is re-checked server-side on every request; this
            link existing is not itself a grant of access. */}
        <button
          type="button"
          onClick={() => void navigate(`/dashboard/team/${member.userId}`)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "var(--text-primary)",
            cursor: "pointer",
            textDecoration: "underline",
            textDecorationColor: "transparent",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.textDecorationColor = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.textDecorationColor = "transparent";
          }}
        >
          {member.name}
        </button>
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          textAlign: "right",
          color: "var(--text-secondary)",
          fontWeight: 600,
        }}
      >
        {member.ticketCount}
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          textAlign: "right",
          fontWeight: 700,
          color:
            member.overdueCount > 0 ? "hsl(350,80%,60%)" : "var(--text-muted)",
        }}
      >
        {member.overdueCount}
      </td>
    </tr>
  );
}

// R7 — team roster table: every direct/indirect report, even at zero
// tickets, so the manager sees their full team at a glance, not just the
// subset with activity.
function TeamMembersTable({
  items,
  page,
  onPageChange,
}: {
  items: TeamMember[];
  page: number;
  onPageChange: (page: number) => void;
}): React.ReactElement {
  if (items.length === 0) {
    return (
      <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
        No direct or indirect reports found.
      </div>
    );
  }
  const sorted = [...items].sort((a, b) => b.ticketCount - a.ticketCount);
  const pageItems = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  return (
    <div>
      <div className="table-scroll">
        <table
          style={{
            width: "100%",
            minWidth: "360px",
            borderCollapse: "collapse",
            fontSize: "13px",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  fontSize: "11px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  padding: "0 4px 8px",
                  borderBottom: "1px solid var(--border-color)",
                }}
              >
                Team member
              </th>
              <th
                style={{
                  textAlign: "right",
                  fontSize: "11px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  padding: "0 4px 8px",
                  borderBottom: "1px solid var(--border-color)",
                  whiteSpace: "nowrap",
                }}
              >
                Tickets
              </th>
              <th
                style={{
                  textAlign: "right",
                  fontSize: "11px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  padding: "0 4px 8px",
                  borderBottom: "1px solid var(--border-color)",
                  whiteSpace: "nowrap",
                }}
              >
                Overdue
              </th>
            </tr>
          </thead>
          <tbody>
            {pageItems.map((m) => (
              <TeamMemberRow key={m.userId} member={m} />
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        totalItems={sorted.length}
        onChange={onPageChange}
      />
    </div>
  );
}

// Own hover state per row (not one shared toggle for the whole table) —
// matches TicketRow's/TeamMemberRow's convention.
function TeamTicketRow({
  ticket,
  onOpen,
}: {
  ticket: TicketSummary;
  onOpen: (entityTypeId: string, entityId: string) => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: "var(--bg-tertiary)" },
  });

  return (
    <tr
      onClick={() => onOpen(ticket.entityTypeId, ticket.entityId)}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
      style={{ cursor: "pointer", ...rowHover.style }}
    >
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-primary)",
          maxWidth: "260px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {ticket.title}
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        {ticket.assignedToName ?? "—"}
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-secondary)",
          whiteSpace: "nowrap",
          maxWidth: "160px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {ticket.workflowName ?? "—"}
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          textAlign: "right",
          fontWeight: 600,
          whiteSpace: "nowrap",
          color: ticket.isOverdue ? "hsl(350,80%,60%)" : "var(--text-muted)",
        }}
      >
        {ticket.stateName}
      </td>
    </tr>
  );
}

export function OrgDashboardBody({
  view,
  loading,
  onOpenRecord,
}: {
  view: OrgView;
  loading: boolean;
  onOpenRecord: (entityTypeId: string, entityId: string) => void;
}): React.ReactElement {
  // Hooks must run unconditionally before the loading/unavailable early
  // returns below (Rules of Hooks) — this only ever matters once loading is
  // false and the ticket list actually renders.
  const [ticketFilter, setTicketFilter] = useState<TicketFilter>("all");
  const [ticketSearch, setTicketSearch] = useState("");
  const [ticketPage, setTicketPage] = useState(1);
  const [teamPage, setTeamPage] = useState(1);

  if (loading) {
    return (
      <div style={{ padding: "24px 0" }}>
        <div
          className="lp-spinner"
          aria-label="Loading org view"
          style={{ margin: "40px auto" }}
        />
      </div>
    );
  }

  // Distinct from the empty state (hasReports:false). The request failed; never
  // blocks My View, which renders independently (R3).
  if (view.unavailable) {
    return (
      <Card accentColor="hsl(340,80%,58%)">
        <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          The org view could not be loaded right now. This doesn&apos;t affect
          your own tickets.
        </div>
      </Card>
    );
  }

  const totalTickets = view.workflows.reduce((sum, w) => sum + w.total, 0);
  const overdueCount =
    view.dueDates.items.length > 0
      ? (view.dueDates.items as Array<{ isOverdue: boolean }>).filter(
          (i) => i.isOverdue,
        ).length
      : 0;
  const atRiskCount = view.slaRisk.totalQualifying;

  const overdueTickets = view.tickets.items.filter((t) => t.isOverdue);
  const dueSoonTickets = view.tickets.items.filter(
    (t) => !t.isOverdue && t.dueDate !== null && daysUntil(t.dueDate) <= 2,
  );
  const tabFilteredTickets =
    ticketFilter === "overdue"
      ? overdueTickets
      : ticketFilter === "due-soon"
        ? dueSoonTickets
        : view.tickets.items;
  const searchTerm = ticketSearch.trim().toLowerCase();
  const filteredTickets = searchTerm
    ? tabFilteredTickets.filter(
        (t) =>
          t.title.toLowerCase().includes(searchTerm) ||
          (t.assignedToName ?? "").toLowerCase().includes(searchTerm),
      )
    : tabFilteredTickets;
  const pagedTickets = filteredTickets.slice(
    (ticketPage - 1) * PAGE_SIZE,
    ticketPage * PAGE_SIZE,
  );

  return (
    <div>
      {view.truncated && (
        <div
          role="status"
          style={{
            padding: "10px 14px",
            marginBottom: "16px",
            borderRadius: "8px",
            border: "1px solid hsla(35,90%,50%,.35)",
            background: "hsla(35,90%,50%,.1)",
            color: "var(--text-secondary)",
            fontSize: "13px",
          }}
        >
          This view includes only the most recently created 2,000 tickets.
          Totals and team-member counts may be lower than the actual values.
        </div>
      )}

      {/* ── KPI strip — same tiles/colors/icons as My View ─────────────────── */}
      <div
        className="dash-kpi"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "14px",
          marginBottom: "20px",
        }}
      >
        <KpiTile
          label="Team Tickets"
          value={totalTickets}
          icon="📋"
          color="hsl(211,100%,45%)"
        />
        <KpiTile
          label="Overdue"
          value={overdueCount}
          icon="⏰"
          color="hsl(350,80%,60%)"
        />
        <KpiTile
          label="At SLA Risk"
          value={atRiskCount}
          icon="⚠️"
          color="hsl(340,80%,58%)"
        />
        <KpiTile
          label="Team Members"
          value={view.teamMembers.items.length}
          icon="👥"
          color="hsl(185,80%,40%)"
        />
      </div>

      <Card accentColor="hsl(185,80%,40%)" style={{ marginBottom: "20px" }}>
        <SectionHeader
          title={`Team (${view.teamMembers.items.length})`}
          icon="👥"
          color="hsl(185,80%,40%)"
        />
        <TeamMembersTable
          items={view.teamMembers.items}
          page={teamPage}
          onPageChange={setTeamPage}
        />
      </Card>

      <div
        className="dash-body"
        style={{
          display: "grid",
          gridTemplateColumns: "1.1fr 0.9fr",
          gap: "20px",
          marginBottom: "20px",
        }}
      >
        <Card accentColor="hsl(265,84%,60%)">
          <SectionHeader
            title="By Workflow"
            icon="📊"
            color="hsl(265,84%,60%)"
          />
          {view.workflows.length === 0 ? (
            <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              No tickets across your team right now.
            </div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              {view.workflows.map((wf) => (
                <div key={wf.workflowId}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "13px",
                      marginBottom: "4px",
                    }}
                  >
                    <span
                      style={{ fontWeight: 600, color: "var(--text-primary)" }}
                    >
                      {wf.workflowName}
                    </span>
                    <span
                      style={{ fontWeight: 700, color: "var(--text-primary)" }}
                    >
                      {wf.total}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}
                  >
                    {wf.counts.map((c) => (
                      <span
                        key={c.stateId}
                        style={{
                          fontSize: "11px",
                          padding: "2px 8px",
                          borderRadius: "999px",
                          background: "var(--bg-tertiary)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {c.stateName}: {c.count}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card accentColor="hsl(340,80%,58%)">
          <SectionHeader
            title="SLA Risk"
            icon="⚠️"
            color="hsl(340,80%,58%)"
            action={
              view.slaRisk.items.length > 0 ? (
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: "20px",
                    background: "hsla(340,80%,58%,.12)",
                    color: "hsl(340,80%,58%)",
                    border: "1px solid hsla(340,80%,58%,.25)",
                  }}
                >
                  {view.slaRisk.totalQualifying}
                </span>
              ) : undefined
            }
          />
          {view.slaRisk.items.length === 0 ? (
            <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Nothing over its SLA. ✅
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {view.slaRisk.items.map((item, idx) => (
                <div
                  key={item.entityId}
                  onClick={() => onOpenRecord(item.entityTypeId, item.entityId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "9px 4px",
                    borderBottom:
                      idx < view.slaRisk.items.length - 1
                        ? "1px solid var(--border-color)"
                        : "none",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.title}
                    </div>
                    <div
                      style={{ fontSize: "11px", color: "var(--text-muted)" }}
                    >
                      {item.stateName}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "hsl(340,80%,58%)",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {formatHoursOver(item.hoursOver)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card accentColor="hsl(211,100%,50%)">
        <SectionHeader
          title={`Team Tickets (${view.tickets.totalQualifying})`}
          icon="📋"
          color="hsl(211,100%,50%)"
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
            marginBottom: "16px",
          }}
        >
          <FilterTabs
            active={ticketFilter}
            onChange={(f) => {
              setTicketFilter(f);
              setTicketPage(1);
            }}
            counts={{
              all: view.tickets.items.length,
              dueSoon: dueSoonTickets.length,
              overdue: overdueTickets.length,
            }}
          />
          <input
            type="text"
            value={ticketSearch}
            onChange={(e) => {
              setTicketSearch(e.target.value);
              setTicketPage(1);
            }}
            placeholder="Search by ticket or team member…"
            style={{
              flex: 1,
              minWidth: "200px",
              padding: "7px 12px",
              borderRadius: "8px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-tertiary)",
              color: "var(--text-primary)",
              fontSize: "13px",
            }}
          />
        </div>
        {filteredTickets.length === 0 ? (
          <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            {searchTerm
              ? "No tickets match your search."
              : ticketFilter === "overdue"
                ? "Nothing overdue across your team. ✅"
                : ticketFilter === "due-soon"
                  ? "Nothing due in the next 2 days."
                  : "No tickets across your team right now."}
          </div>
        ) : (
          <div className="table-scroll">
            <table
              style={{
                width: "100%",
                minWidth: "560px",
                borderCollapse: "collapse",
                fontSize: "13px",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-muted)",
                      padding: "0 4px 8px",
                      borderBottom: "1px solid var(--border-color)",
                    }}
                  >
                    Ticket
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-muted)",
                      padding: "0 4px 8px",
                      borderBottom: "1px solid var(--border-color)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Team Member
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-muted)",
                      padding: "0 4px 8px",
                      borderBottom: "1px solid var(--border-color)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Workflow
                  </th>
                  <th
                    style={{
                      textAlign: "right",
                      fontSize: "11px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--text-muted)",
                      padding: "0 4px 8px",
                      borderBottom: "1px solid var(--border-color)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {pagedTickets.map((t) => (
                  <TeamTicketRow
                    key={t.entityId}
                    ticket={t}
                    onOpen={onOpenRecord}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={ticketPage}
          totalItems={filteredTickets.length}
          onChange={setTicketPage}
        />
      </Card>
    </div>
  );
}
