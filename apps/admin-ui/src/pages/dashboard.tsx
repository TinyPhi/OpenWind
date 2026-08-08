import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useGetIdentity } from "@refinedev/core";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { useEntityTypes, toTypeSlug } from "../entity-type-context.js";
import { useHoverStyle } from "@platform/ui";
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  type NotificationItem,
} from "../lib/notifications-client.js";
import { relativeTime } from "../lib/format.js";

// ── Personal dashboard ("My View") — docs/specs/personal-dashboard.md ─────────
// Reachable by every authenticated role. Gives the logged-in user a status
// overview of THEIR OWN work (assigned + created + watching, same predicate as
// /entities/my-tickets): how much of it, where it stands, and what needs
// attention right now — not a per-ticket listing (that's what /records already
// does; this page deliberately doesn't duplicate it). The tenant-wide KPI page
// that used to live at this route/name is now Analytics (analytics.tsx,
// admin/agent only, mounted at /analytics).

type WorkflowStateCount = { stateId: string; stateName: string; count: number };

type WorkflowBreakdown = {
  workflowId: string;
  workflowName: string;
  counts: WorkflowStateCount[];
  total: number;
};

type DueDateItem = {
  entityId: string;
  entityTypeId: string;
  entityTypeName: string;
  workflowId: string | null;
  title: string;
  dueDate: string;
  isOverdue: boolean;
};

// Every scoped ticket, irrespective of workflow, whether or not it has a
// due_date — unlike DueDateItem above, which only covers the has-a-due-date
// subset. This is the source for the flat "my tickets" tables.
type TicketSummary = {
  entityId: string;
  entityTypeId: string;
  entityTypeName: string;
  workflowId: string | null;
  workflowName: string | null;
  stateName: string;
  title: string;
  dueDate: string | null;
  isOverdue: boolean;
};

type SlaRiskItem = {
  entityId: string;
  entityTypeId: string;
  entityTypeName: string;
  title: string;
  workflowId: string;
  stateName: string;
  hoursOver: number;
};

type AdminWorkflow = {
  workflowId: string;
  workflowName: string;
  entityTypeId: string;
};

type SavedViewSummary = {
  id: string;
  name: string;
  entityTypeId: string;
  entityTypeName: string;
};

type PendingApprovalItem = {
  requestId: string;
  entityId: string;
  entityTypeId: string;
  entityTypeName: string;
  title: string;
  requesterId: string;
  workflowId: string;
  workflowName: string;
  requestedLevel: "read_only" | "read_comment" | "read_write";
  createdAt: string;
};

type MyView = {
  workflows: WorkflowBreakdown[];
  tickets: {
    items: TicketSummary[];
    totalQualifying: number;
    unavailable?: boolean;
  };
  dueDates: {
    items: DueDateItem[];
    totalQualifying: number;
    unavailable?: boolean;
  };
  slaRisk: {
    items: SlaRiskItem[];
    totalQualifying: number;
    unavailable?: boolean;
  };
  adminWorkflows: AdminWorkflow[];
  savedViews: SavedViewSummary[];
  pendingApprovals: {
    items: PendingApprovalItem[];
    totalQualifying: number;
    unavailable?: boolean;
  };
};

const EMPTY_VIEW: MyView = {
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
  adminWorkflows: [],
  savedViews: [],
  pendingApprovals: { items: [], totalQualifying: 0 },
};

// Fixed categorical order (never cycled/reassigned by filtering) — same accent
// family analytics.tsx already uses, reused here for visual consistency across
// the two dashboard pages rather than inventing a second palette.
const CATEGORY_COLORS = [
  "hsl(211,100%,50%)",
  "hsl(265,84%,60%)",
  "hsl(150,75%,40%)",
  "hsl(35,90%,50%)",
  "hsl(340,80%,58%)",
  "hsl(185,80%,40%)",
];
const OTHER_COLOR = "hsl(222,10%,55%)";

// Same slugification workflow-scoped pages already use (records/index.tsx,
// entities/my-tickets.ts) — no shared export exists across the two apps, so
// this is duplicated rather than newly centralized (out of scope here).
function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function withAlpha(color: string, alpha: number): string {
  const match = /^hsl\(([^)]+)\)$/.exec(color);
  return match ? `hsla(${match[1]}, ${alpha})` : color;
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function formatDueBadge(item: {
  dueDate: string | null;
  isOverdue: boolean;
}): string {
  if (item.dueDate === null) return "No due date";
  const d = daysUntil(item.dueDate);
  if (item.isOverdue) return `Overdue ${Math.abs(d)}d`;
  if (d === 0) return "Due today";
  return `Due in ${d}d`;
}

function formatHoursOver(hours: number): string {
  if (hours < 24) return `${Math.round(hours)}h over SLA`;
  return `${Math.round(hours / 24)}d over SLA`;
}

function formatDueDateLong(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── state-mix donut data — top 5 states by count across every workflow, +
// "Other" bucket for the rest (never a generated hue per state — anti-pattern) ─

function buildStateMix(
  workflows: WorkflowBreakdown[],
): { label: string; value: number; color: string }[] {
  const byState = new Map<string, number>();
  for (const wf of workflows) {
    for (const c of wf.counts) {
      byState.set(c.stateName, (byState.get(c.stateName) ?? 0) + c.count);
    }
  }
  const sorted = [...byState.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 5).map(([label, value], i) => ({
    label,
    value,
    color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] ?? OTHER_COLOR,
  }));
  const rest = sorted.slice(5).reduce((sum, [, v]) => sum + v, 0);
  return rest > 0
    ? [...top, { label: "Other", value: rest, color: OTHER_COLOR }]
    : top;
}

// ── small chart primitives (inline SVG — matches analytics.tsx's convention,
// no charting library in this repo) ───────────────────────────────────────────

function Donut({
  segments,
  size = 120,
  strokeWidth = 16,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  strokeWidth?: number;
}): React.ReactElement {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offsetAccum = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--bg-tertiary)"
        strokeWidth={strokeWidth}
      />
      {total > 0 &&
        segments.map((s) => {
          const frac = s.value / total;
          const dash = frac * circumference;
          const dashArray = `${dash} ${circumference - dash}`;
          const dashOffset = -offsetAccum * circumference;
          offsetAccum += frac;
          return (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              strokeLinecap="butt"
            />
          );
        })}
      <text
        x="50%"
        y="47%"
        textAnchor="middle"
        fontSize="22"
        fontWeight="800"
        fill="var(--text-primary)"
      >
        {total}
      </text>
      <text
        x="50%"
        y="64%"
        textAnchor="middle"
        fontSize="9"
        fontWeight="600"
        letterSpacing="0.05em"
        fill="var(--text-muted)"
      >
        TICKETS
      </text>
    </svg>
  );
}

function Legend({
  segments,
}: {
  segments: { label: string; value: number; color: string }[];
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
      {segments.map((s) => (
        <div
          key={s.label}
          style={{ display: "flex", alignItems: "center", gap: "8px" }}
        >
          <span
            style={{
              width: "9px",
              height: "9px",
              borderRadius: "3px",
              background: s.color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {s.label}
          </span>
          <span
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            {s.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function WorkloadBar({
  workflow,
  maxTotal,
  color,
  onClick,
}: {
  workflow: WorkflowBreakdown;
  maxTotal: number;
  color: string;
  onClick: () => void;
}): React.ReactElement {
  const hover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: "var(--bg-tertiary)" },
  });
  const pct =
    maxTotal > 0
      ? Math.max(4, Math.round((workflow.total / maxTotal) * 100))
      : 0;

  return (
    <div
      onClick={onClick}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      style={{
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        padding: "8px 8px",
        ...hover.style,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "12px",
          marginBottom: "5px",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          {workflow.workflowName}
        </span>
        <span style={{ fontWeight: 700, color: "var(--text-primary)" }}>
          {workflow.total}
        </span>
      </div>
      <div
        style={{
          height: "8px",
          borderRadius: "4px",
          background: "var(--bg-tertiary)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: color,
            borderRadius: "4px",
            transition: "width .5s ease",
          }}
        />
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  icon,
  color,
  onClick,
}: {
  label: string;
  value: number;
  icon: string;
  color: string;
  onClick?: () => void;
}): React.ReactElement {
  const hover = useHoverStyle({
    base: { borderColor: withAlpha(color, 0.25), boxShadow: "none" },
    hover: {
      borderColor: color,
      boxShadow: `0 4px 20px ${withAlpha(color, 0.2)}`,
    },
  });

  return (
    <div
      onClick={onClick}
      onMouseEnter={onClick ? hover.onMouseEnter : undefined}
      onMouseLeave={onClick ? hover.onMouseLeave : undefined}
      style={{
        background: withAlpha(color, 0.1),
        border: "1px solid",
        borderRadius: "var(--radius-md)",
        padding: "18px 20px",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        alignItems: "center",
        gap: "14px",
        transition: "border-color .15s, box-shadow .15s",
        ...hover.style,
      }}
    >
      <div
        style={{
          width: "40px",
          height: "40px",
          borderRadius: "10px",
          background: withAlpha(color, 0.16),
          border: `1px solid ${withAlpha(color, 0.3)}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "19px",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: "2px",
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: "24px",
            fontWeight: 800,
            fontFamily: "var(--font-heading)",
            color: "var(--text-primary)",
            lineHeight: 1,
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

type TicketFilter = "all" | "due-soon" | "overdue";

function FilterTabs({
  active,
  onChange,
  counts,
}: {
  active: TicketFilter;
  onChange: (f: TicketFilter) => void;
  counts: { all: number; dueSoon: number; overdue: number };
}): React.ReactElement {
  const tabs: { key: TicketFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "due-soon", label: "Due in 2 Days", count: counts.dueSoon },
    { key: "overdue", label: "Overdue", count: counts.overdue },
  ];
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        gap: "8px",
        marginBottom: "16px",
      }}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "7px 16px",
              borderRadius: "999px",
              fontSize: "12px",
              fontWeight: 700,
              cursor: "pointer",
              border: isActive
                ? "1px solid hsl(211,100%,50%)"
                : "1px solid var(--border-color)",
              background: isActive
                ? "hsla(211,100%,50%,.12)"
                : "var(--bg-tertiary)",
              color: isActive ? "hsl(211,100%,45%)" : "var(--text-secondary)",
              transition: "background .15s, border-color .15s",
            }}
          >
            {tab.label}
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: "999px",
                background: isActive
                  ? "hsl(211,100%,50%)"
                  : "var(--bg-secondary)",
                color: isActive ? "#fff" : "var(--text-muted)",
              }}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Own hover state per row — a single shared useHoverStyle call at the table
// level would highlight EVERY row together on hover (hovered is one boolean
// for the whole table), not just the row under the cursor.
function TicketRow({
  item,
  onOpen,
}: {
  item: TicketSummary;
  onOpen: (entityTypeId: string, entityId: string) => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: "transparent", transform: "scale(1)" },
    hover: { background: "var(--bg-tertiary)", transform: "scale(1.012)" },
  });

  return (
    <tr
      onClick={() => onOpen(item.entityTypeId, item.entityId)}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
      style={{
        cursor: "pointer",
        transition: "transform .12s ease, background .12s ease",
        ...rowHover.style,
      }}
    >
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-primary)",
          maxWidth: "220px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.title}
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
        {item.workflowName ?? "—"}
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          color: "var(--text-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        {formatDueDateLong(item.dueDate)}
      </td>
      <td
        style={{
          padding: "9px 4px",
          borderBottom: "1px solid var(--border-color)",
          color: item.isOverdue ? "hsl(350,80%,60%)" : "hsl(35,90%,50%)",
          fontWeight: 700,
          textAlign: "right",
          whiteSpace: "nowrap",
        }}
      >
        {formatDueBadge(item)}
      </td>
    </tr>
  );
}

function TicketDueDateTable({
  items,
  unavailable,
  loading,
  emptyLabel,
  onOpen,
}: {
  items: TicketSummary[];
  unavailable?: boolean | undefined;
  loading: boolean;
  emptyLabel: string;
  onOpen: (entityTypeId: string, entityId: string) => void;
}): React.ReactElement {
  return (
    <div>
      {unavailable ? (
        <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          Temporarily unavailable — the rest of your dashboard is unaffected.
        </div>
      ) : loading ? (
        <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          {emptyLabel}
        </div>
      ) : (
        <table
          style={{
            width: "100%",
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
                Workflow
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
                Due Date
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
            {items.map((item) => (
              <TicketRow key={item.entityId} item={item} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  icon,
  color,
  action,
}: {
  title: string;
  icon?: string;
  color?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingBottom: "14px",
        borderBottom: "1px solid var(--border-color)",
        marginBottom: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        {icon && (
          <div
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "8px",
              background: withAlpha(color ?? "hsl(211,100%,50%)", 0.14),
              border: `1px solid ${withAlpha(color ?? "hsl(211,100%,50%)", 0.28)}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "13px",
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
        )}
        <h3
          style={{
            fontSize: "13.5px",
            fontWeight: 700,
            color: "var(--text-primary)",
            letterSpacing: "0.01em",
            margin: 0,
          }}
        >
          {title}
        </h3>
      </div>
      {action}
    </div>
  );
}

// Card wrapper — data-panel with a colored top accent bar so panels read as
// distinct sections at a glance instead of a stack of identical gray boxes.
function Card({
  accentColor,
  style,
  children,
}: {
  accentColor: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className="data-panel"
      style={{
        padding: "20px",
        marginBottom: 0,
        borderTop: `3px solid ${accentColor}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── main Dashboard ────────────────────────────────────────────────────────────

export function Dashboard(): React.ReactElement {
  const navigate = useNavigate();
  const { getTypeById } = useEntityTypes();
  const { data: identity } = useGetIdentity<{ name: string }>();
  const [view, setView] = useState<MyView>(EMPTY_VIEW);
  const [loading, setLoading] = useState(true);
  const [recentNotifications, setRecentNotifications] = useState<
    NotificationItem[]
  >([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    fetchWithAuth(`${API_URL}/dashboard/my-view`)
      .then((res) => {
        const data = (res as { data?: MyView }).data;
        setView(data ?? EMPTY_VIEW);
      })
      .catch(() => setView(EMPTY_VIEW))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    Promise.all([listNotifications(), getUnreadCount()])
      .then(([list, count]) => {
        setRecentNotifications(list.data.slice(0, 5));
        setUnreadCount(count);
      })
      .catch(() => {
        setRecentNotifications([]);
        setUnreadCount(0);
      });
  }, []);

  const firstName = (identity?.name ?? "there").split(" ")[0] ?? "there";

  const totalTickets = useMemo(
    () => view.workflows.reduce((sum, w) => sum + w.total, 0),
    [view.workflows],
  );
  const overdueCount = useMemo(
    () => view.dueDates.items.filter((i) => i.isOverdue).length,
    [view.dueDates.items],
  );
  const dueThisWeekCount = useMemo(
    () =>
      view.dueDates.items.filter(
        (i) => !i.isOverdue && daysUntil(i.dueDate) <= 7,
      ).length,
    [view.dueDates.items],
  );
  const atRiskCount = view.slaRisk.totalQualifying;

  const stateMix = useMemo(
    () => buildStateMix(view.workflows),
    [view.workflows],
  );
  // Flat across every workflow, INCLUDING tickets with no due_date at all —
  // sourced from view.tickets (not view.dueDates, which only covers the
  // has-a-due-date subset). Already sorted overdue-first / soonest-first /
  // undated-last by the API (see buildTicketsSection in my-view.ts); split
  // here purely for the two-table UI, not merged with SLA risk (§V: never
  // merge the two signals).
  const overdueTickets = useMemo(
    () => view.tickets.items.filter((i) => i.isOverdue),
    [view.tickets.items],
  );
  const dueSoonTickets = useMemo(
    () =>
      view.tickets.items.filter(
        (i) => !i.isOverdue && i.dueDate !== null && daysUntil(i.dueDate) <= 2,
      ),
    [view.tickets.items],
  );
  const [ticketFilter, setTicketFilter] = useState<TicketFilter>("all");
  const filteredTickets = useMemo(() => {
    if (ticketFilter === "overdue") return overdueTickets;
    if (ticketFilter === "due-soon") return dueSoonTickets;
    return view.tickets.items;
  }, [ticketFilter, overdueTickets, dueSoonTickets, view.tickets.items]);
  const maxWorkflowTotal = useMemo(
    () => Math.max(1, ...view.workflows.map((w) => w.total)),
    [view.workflows],
  );

  function openWorkflow(workflowName: string): void {
    // R6 — reuses /records's existing filter-chip contract exactly (§V): the
    // "assigned to me" chip is the closest existing equivalent to a
    // workflow+assigned-to-me filter for a workflow-level (not per-ticket) drill-down.
    navigate(
      `/workflows/${toWorkflowSlug(workflowName)}/records?filter=assigned`,
    );
  }

  function openRecord(entityTypeId: string, entityId: string): void {
    const type = getTypeById(entityTypeId);
    if (!type) return;
    navigate(`/records/${toTypeSlug(type.plural || type.name)}/${entityId}`);
  }

  function openAdminWorkflow(workflowName: string): void {
    navigate(`/workflows/${toWorkflowSlug(workflowName)}`);
  }

  function openNotification(n: NotificationItem): void {
    void markNotificationRead(n.id);
    setRecentNotifications((prev) =>
      prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
    );
    setUnreadCount((prev) => (n.read ? prev : Math.max(0, prev - 1)));
    if (n.link) navigate(n.link);
  }

  // R11 — saved_views has no consumer UI anywhere in admin-ui yet (no page
  // applies a saved filterConfig from a URL param), so this is a best-effort
  // quick link to the general records page rather than a true "apply this
  // view" deep link. Building that is future work, not part of this pass.
  function openSavedView(): void {
    navigate("/records");
  }

  const hasWorkload = view.workflows.length > 0;
  const needsAttentionCount = overdueTickets.length + view.slaRisk.items.length;

  return (
    <div style={{ padding: "24px 28px" }}>
      {/* ── header ────────────────────────────────────────────────────────── */}
      <div
        className="dash-header"
        style={{
          background: "var(--accent-gradient)",
          borderRadius: "var(--radius-md)",
          padding: "22px 26px",
          marginBottom: "20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          boxShadow: "0 8px 24px hsla(175,70%,44%,.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              background: "hsla(0,0%,100%,.2)",
              border: "1px solid hsla(0,0%,100%,.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "18px",
              fontWeight: 800,
              color: "#fff",
              flexShrink: 0,
            }}
          >
            {firstName.charAt(0).toUpperCase()}
          </div>
          <div>
            <div
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: "hsla(0,0%,100%,.8)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: "3px",
              }}
            >
              My Dashboard
            </div>
            <h2
              style={{
                fontSize: "21px",
                fontWeight: 800,
                fontFamily: "var(--font-heading)",
                color: "#fff",
                margin: 0,
              }}
            >
              Hi {firstName}
            </h2>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 16px",
            borderRadius: "999px",
            background: "hsla(0,0%,100%,.16)",
            border: "1px solid hsla(0,0%,100%,.3)",
            fontSize: "13px",
            fontWeight: 700,
            color: "#fff",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontSize: "15px" }}>
            {loading ? "⏳" : needsAttentionCount > 0 ? "🔔" : "✅"}
          </span>
          {loading
            ? "Loading your work…"
            : needsAttentionCount > 0
              ? `${needsAttentionCount} ticket${needsAttentionCount === 1 ? "" : "s"} need attention`
              : "All caught up"}
        </div>
      </div>

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
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
          label="My Tickets"
          value={loading ? 0 : totalTickets}
          icon="📋"
          color="hsl(211,100%,45%)"
          onClick={() => navigate("/records")}
        />
        <KpiTile
          label="Due This Week"
          value={loading ? 0 : dueThisWeekCount}
          icon="📅"
          color="hsl(35,90%,50%)"
        />
        <KpiTile
          label="Overdue"
          value={loading ? 0 : overdueCount}
          icon="⏰"
          color="hsl(350,80%,60%)"
        />
        <KpiTile
          label="At SLA Risk"
          value={loading ? 0 : atRiskCount}
          icon="⚠️"
          color="hsl(340,80%,58%)"
        />
      </div>

      {/* ── My Tickets — flat across every workflow (not grouped), whether or
          not they have a due date. Filterable via tabs (All / Due in 2 Days /
          Overdue) instead of two separate tables. Clicking a row goes
          straight to the ticket's detail page. ───────────────────────────── */}
      <Card accentColor="hsl(211,100%,50%)" style={{ marginBottom: "20px" }}>
        <SectionHeader title="My Tickets" icon="📋" color="hsl(211,100%,50%)" />
        <FilterTabs
          active={ticketFilter}
          onChange={setTicketFilter}
          counts={{
            all: view.tickets.items.length,
            dueSoon: dueSoonTickets.length,
            overdue: overdueTickets.length,
          }}
        />
        <TicketDueDateTable
          items={filteredTickets}
          unavailable={view.tickets.unavailable}
          loading={loading}
          emptyLabel={
            ticketFilter === "overdue"
              ? "Nothing overdue. ✅"
              : ticketFilter === "due-soon"
                ? "Nothing due in the next 2 days."
                : "No tickets assigned, created, or watched by you yet."
          }
          onOpen={openRecord}
        />
      </Card>

      {/* ── two-column body ───────────────────────────────────────────────── */}
      <div
        className="dash-body"
        style={{
          display: "grid",
          gridTemplateColumns: "1.1fr 0.9fr",
          gap: "20px",
        }}
      >
        {/* left column — workload + status mix */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <Card accentColor="hsl(265,84%,60%)">
            <SectionHeader
              title="My Workload"
              icon="📊"
              color="hsl(265,84%,60%)"
            />
            {loading ? (
              <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                Loading…
              </div>
            ) : !hasWorkload ? (
              <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                No tickets assigned, created, or watched by you yet.
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "2px" }}
              >
                {view.workflows.map((wf, i) => (
                  <WorkloadBar
                    key={wf.workflowId}
                    workflow={wf}
                    maxTotal={maxWorkflowTotal}
                    color={
                      CATEGORY_COLORS[i % CATEGORY_COLORS.length] ?? OTHER_COLOR
                    }
                    onClick={() => openWorkflow(wf.workflowName)}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card accentColor="hsl(150,75%,40%)">
            <SectionHeader
              title="Status Mix"
              icon="🧩"
              color="hsl(150,75%,40%)"
            />
            {loading ? (
              <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                Loading…
              </div>
            ) : stateMix.length === 0 ? (
              <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                Nothing to show yet.
              </div>
            ) : (
              <div
                style={{ display: "flex", alignItems: "center", gap: "22px" }}
              >
                <Donut segments={stateMix} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Legend segments={stateMix} />
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* right column — SLA risk (kept separate from due dates — §V: the
            two are different signals, never merged into one score/list) ──── */}
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
          {view.slaRisk.unavailable ? (
            <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Temporarily unavailable — the rest of your dashboard is
              unaffected.
            </div>
          ) : loading ? (
            <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Loading…
            </div>
          ) : view.slaRisk.items.length === 0 ? (
            <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
              Nothing over its SLA. ✅
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {view.slaRisk.items.map((s, idx) => (
                <div
                  key={s.entityId}
                  onClick={() => openRecord(s.entityTypeId, s.entityId)}
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
                      {s.title}
                    </div>
                    <div
                      style={{ fontSize: "11px", color: "var(--text-muted)" }}
                    >
                      {s.stateName}
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
                    {formatHoursOver(s.hoursOver)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── v1.1 widgets — each omitted entirely when empty (no admin
          workflows / no pending approvals / no saved views is the common
          case for a plain user, not an error state) ─────────────────────── */}
      {(recentNotifications.length > 0 ||
        view.adminWorkflows.length > 0 ||
        view.pendingApprovals.items.length > 0 ||
        view.savedViews.length > 0) && (
        <div
          className="dash-body"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "20px",
            marginTop: "20px",
          }}
        >
          {recentNotifications.length > 0 && (
            <Card accentColor="hsl(211,100%,50%)">
              <SectionHeader
                title="Notifications"
                icon="🔔"
                color="hsl(211,100%,50%)"
                action={
                  unreadCount > 0 ? (
                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "20px",
                        background: "hsla(211,100%,50%,.12)",
                        color: "hsl(211,100%,45%)",
                        border: "1px solid hsla(211,100%,50%,.25)",
                      }}
                    >
                      {unreadCount} unread
                    </span>
                  ) : undefined
                }
              />
              <div style={{ display: "flex", flexDirection: "column" }}>
                {recentNotifications.map((n, idx) => (
                  <div
                    key={n.id}
                    onClick={() => openNotification(n)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "9px 4px",
                      borderBottom:
                        idx < recentNotifications.length - 1
                          ? "1px solid var(--border-color)"
                          : "none",
                      cursor: "pointer",
                    }}
                  >
                    {!n.read && (
                      <div
                        style={{
                          width: "7px",
                          height: "7px",
                          borderRadius: "50%",
                          background: "hsl(211,100%,50%)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        marginLeft: n.read ? "17px" : 0,
                      }}
                    >
                      <div
                        style={{
                          fontSize: "13px",
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {n.title}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {relativeTime(n.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {view.adminWorkflows.length > 0 && (
            <Card accentColor="hsl(185,80%,40%)">
              <SectionHeader
                title="Workflows I Administer"
                icon="🛡️"
                color="hsl(185,80%,40%)"
              />
              <div
                style={{ display: "flex", flexDirection: "column", gap: "2px" }}
              >
                {view.adminWorkflows.map((wf) => (
                  <div
                    key={wf.workflowId}
                    onClick={() => openAdminWorkflow(wf.workflowName)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "9px 4px",
                      cursor: "pointer",
                      fontSize: "13px",
                      color: "var(--text-primary)",
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {wf.workflowName}
                    </span>
                    <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>
                      →
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {view.pendingApprovals.items.length > 0 && (
            <Card accentColor="hsl(35,90%,50%)">
              <SectionHeader
                title="Awaiting Your Approval"
                icon="✋"
                color="hsl(35,90%,50%)"
                action={
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "20px",
                      background: "hsla(35,90%,50%,.12)",
                      color: "hsl(35,90%,50%)",
                      border: "1px solid hsla(35,90%,50%,.25)",
                    }}
                  >
                    {view.pendingApprovals.totalQualifying}
                  </span>
                }
              />
              {view.pendingApprovals.unavailable ? (
                <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                  Temporarily unavailable — the rest of your dashboard is
                  unaffected.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {view.pendingApprovals.items.map((a, idx) => (
                    <div
                      key={a.requestId}
                      onClick={() => openRecord(a.entityTypeId, a.entityId)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "9px 4px",
                        borderBottom:
                          idx < view.pendingApprovals.items.length - 1
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
                          {a.title}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "var(--text-muted)",
                          }}
                        >
                          {a.workflowName} · requested{" "}
                          {a.requestedLevel.replace("_", " ")}
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        {relativeTime(a.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {view.savedViews.length > 0 && (
            <Card accentColor="hsl(265,84%,60%)">
              <SectionHeader
                title="Saved Views"
                icon="⭐"
                color="hsl(265,84%,60%)"
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {view.savedViews.map((v) => (
                  <span
                    key={v.id}
                    onClick={openSavedView}
                    style={{
                      fontSize: "12px",
                      fontWeight: 600,
                      padding: "6px 12px",
                      borderRadius: "999px",
                      background: "var(--bg-tertiary)",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    {v.name}
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
