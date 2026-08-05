import React, { useEffect, useState } from "react";
import { useGetIdentity } from "@refinedev/core";
import { useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager } from "../authProvider.js";
import { Button, TOKENS, useHoverStyle } from "@platform/ui";

type WorkflowState = {
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
  slaHours?: number | null;
};

type Workflow = {
  id: string;
  name: string;
  entityTypeId: string;
  isActive: boolean;
  states: WorkflowState[];
};

type EntityRecord = {
  id: string;
  currentState: string | null;
  createdAt?: string;
  updatedAt?: string;
  assignedTo?: string | null;
  fields?: Record<string, unknown>;
};

type OrgUser = {
  userId: string;
  email: string;
  displayName: string | null;
};

type WorkflowStat = {
  workflow: Workflow;
  total: number;
  open: number;
  closed: number;
  records: EntityRecord[];
};

type Module = {
  slug: string;
  name: string;
  installed: boolean;
};

type RecentRecord = {
  title: string;
  workflowName: string;
  workflowSlug: string;
  state: string | null;
  color: string | null;
  createdAt: string | undefined;
  assigneeLabel: string | null;
};

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getTodayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// `color` is always an `hsl(h, s%, l%)` literal from WORKFLOW_COLORS / KpiCard
// callers — this turns it into an `hsla(...)` with the given alpha so it can
// be used as a translucent fill (string-concat like `${color}33` is invalid
// on hsl() values, only on hex).
function withAlpha(color: string, alpha: number): string {
  const match = /^hsl\(([^)]+)\)$/.exec(color);
  return match ? `hsla(${match[1]}, ${alpha})` : color;
}

function recordTitle(rec: EntityRecord): string {
  const f = rec.fields ?? {};
  const v = f.subject ?? f.title ?? f.name;
  return v ? String(v) : `#${rec.id.slice(0, 8)}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Daily counts for the last `days` days, oldest first, based on `createdAt`.
function dailyCounts(records: EntityRecord[], days: number): number[] {
  const buckets = new Array(days).fill(0) as number[];
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const dayMs = 86_400_000;
  for (const r of records) {
    if (!r.createdAt) continue;
    const t = new Date(r.createdAt).getTime();
    const dayIndex = days - 1 - Math.floor((todayStart - t) / dayMs);
    if (dayIndex >= 0 && dayIndex < days) {
      buckets[dayIndex] = (buckets[dayIndex] ?? 0) + 1;
    }
  }
  return buckets;
}

const WORKFLOW_COLORS = [
  {
    bg: "hsla(211,100%,50%,.08)",
    border: "hsla(211,100%,50%,.2)",
    accent: "hsl(211,100%,45%)",
  },
  {
    bg: "hsla(265,84%,60%,.08)",
    border: "hsla(265,84%,60%,.2)",
    accent: "hsl(265,84%,60%)",
  },
  {
    bg: "hsla(150,75%,40%,.08)",
    border: "hsla(150,75%,40%,.2)",
    accent: "hsl(150,75%,40%)",
  },
  {
    bg: "hsla(35,90%,55%,.08)",
    border: "hsla(35,90%,55%,.2)",
    accent: "hsl(35,90%,50%)",
  },
  {
    bg: "hsla(340,80%,58%,.08)",
    border: "hsla(340,80%,58%,.2)",
    accent: "hsl(340,80%,58%)",
  },
  {
    bg: "hsla(185,80%,40%,.08)",
    border: "hsla(185,80%,40%,.2)",
    accent: "hsl(185,80%,40%)",
  },
];

// ── sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  icon,
  color,
  onClick,
  spark,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: string;
  color: string;
  onClick?: () => void;
  spark?: number[];
}): React.ReactElement {
  const cardHover = useHoverStyle({
    base: { borderColor: withAlpha(color, 0.25), boxShadow: "none" },
    hover: {
      borderColor: color,
      boxShadow: `0 4px 20px ${withAlpha(color, 0.2)}`,
    },
  });

  return (
    <div
      onClick={onClick}
      style={{
        background: withAlpha(color, 0.1),
        border: "1px solid",
        borderRadius: "var(--radius-md)",
        padding: "20px 22px",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        alignItems: "flex-start",
        gap: "16px",
        transition: "border-color .15s, box-shadow .15s",
        position: "relative",
        overflow: "hidden",
        ...cardHover.style,
      }}
      onMouseEnter={onClick ? cardHover.onMouseEnter : undefined}
      onMouseLeave={onClick ? cardHover.onMouseLeave : undefined}
    >
      {/* icon */}
      <div
        style={{
          width: "44px",
          height: "44px",
          borderRadius: "10px",
          background: withAlpha(color, 0.16),
          border: `1px solid ${withAlpha(color, 0.3)}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "22px",
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      {/* content */}
      <div
        style={{ flex: 1, display: "flex", alignItems: "center", gap: "12px" }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: "4px",
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: "28px",
              fontWeight: 800,
              fontFamily: "var(--font-heading)",
              color: "var(--text-primary)",
              lineHeight: 1,
              marginBottom: "4px",
            }}
          >
            {value}
          </div>
          {sub && (
            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              {sub}
            </div>
          )}
        </div>
        {spark && spark.length > 1 && (
          <Sparkline values={spark} color={color} />
        )}
      </div>
    </div>
  );
}

function ProgressBar({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  color: string;
}): React.ReactElement {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <div
        style={{
          flex: 1,
          height: "6px",
          background: "var(--bg-tertiary)",
          borderRadius: "3px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: color,
            borderRadius: "3px",
            transition: "width .5s ease",
          }}
        />
      </div>
      <span
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-muted)",
          minWidth: "28px",
          textAlign: "right",
        }}
      >
        {pct}%
      </span>
    </div>
  );
}

function Sparkline({
  values,
  color,
}: {
  values: number[];
  color: string;
}): React.ReactElement {
  const w = 72;
  const h = 24;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values
    .map((v, i) => `${i * step},${h - (v / max) * (h - 4) - 2}`)
    .join(" ");
  const lastX = (values.length - 1) * step;
  const lastValue = values[values.length - 1] ?? 0;
  const lastY = h - (lastValue / max) * (h - 4) - 2;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ overflow: "visible", flexShrink: 0 }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

function Donut({
  segments,
  size = 108,
  strokeWidth = 14,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  size?: number;
  strokeWidth?: number;
}): React.ReactElement {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offsetAccum = 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "18px" }}>
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
          fontSize="20"
          fontWeight="800"
          fill="var(--text-primary)"
        >
          {total}
        </text>
        <text
          x="50%"
          y="63%"
          textAnchor="middle"
          fontSize="9"
          fontWeight="600"
          letterSpacing="0.05em"
          fill="var(--text-muted)"
        >
          RECORDS
        </text>
      </svg>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          flex: 1,
          minWidth: 0,
        }}
      >
        {segments.slice(0, 5).map((s) => (
          <div
            key={s.label}
            style={{ display: "flex", alignItems: "center", gap: "8px" }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "2px",
                background: s.color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                flex: 1,
                minWidth: 0,
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
        {total === 0 && (
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            No records yet
          </span>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        paddingBottom: "12px",
        borderBottom: "1px solid var(--border-color)",
        marginBottom: "16px",
      }}
    >
      <h3
        style={{
          fontSize: "13px",
          fontWeight: 700,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          margin: 0,
        }}
      >
        {title}
      </h3>
      {action}
    </div>
  );
}

function WorkflowPerfRow({
  stat,
  index,
  onClick,
}: {
  stat: WorkflowStat;
  index: number;
  onClick: () => void;
}): React.ReactElement {
  const palette = WORKFLOW_COLORS[index % WORKFLOW_COLORS.length];
  const rowHover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      className="dash-perf-row"
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 60px 60px 60px 160px 60px",
        gap: "0 12px",
        padding: "12px 10px",
        borderBottom: "1px solid var(--border-color)",
        cursor: "pointer",
        transition: "background .12s",
        alignItems: "center",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      {/* name + states */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "4px",
          }}
        >
          <div
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: palette?.accent ?? "var(--accent-primary)",
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {stat.workflow.name}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            gap: "4px",
            flexWrap: "wrap",
            paddingLeft: "16px",
          }}
        >
          {stat.workflow.states
            .filter((st) => !st.isTerminal)
            .slice(0, 4)
            .map((st) => (
              <span
                key={st.name}
                style={{
                  fontSize: "10px",
                  fontWeight: 500,
                  padding: "1px 6px",
                  borderRadius: "3px",
                  background: st.color ? `${st.color}1a` : "var(--bg-tertiary)",
                  color: st.color ?? "var(--text-muted)",
                  border: `1px solid ${st.color ?? "var(--border-color)"}33`,
                }}
              >
                {st.label}
              </span>
            ))}
        </div>
      </div>

      {/* total */}
      <span
        className="dash-perf-col-num"
        style={{
          textAlign: "right",
          fontSize: "14px",
          fontWeight: 700,
          color: "var(--text-primary)",
        }}
      >
        {stat.total}
      </span>

      {/* open */}
      <span
        className="dash-perf-col-num"
        style={{
          textAlign: "right",
          fontSize: "13px",
          fontWeight: 600,
          color: "hsl(35,90%,55%)",
        }}
      >
        {stat.open}
      </span>

      {/* closed */}
      <span
        className="dash-perf-col-num"
        style={{
          textAlign: "right",
          fontSize: "13px",
          fontWeight: 600,
          color: "hsl(150,75%,45%)",
        }}
      >
        {stat.closed}
      </span>

      {/* progress */}
      <div className="dash-perf-col-bar">
        <ProgressBar
          value={stat.closed}
          total={stat.total}
          color={palette?.accent ?? "var(--accent-primary)"}
        />
      </div>

      {/* active badge */}
      <div
        className="dash-perf-col-status"
        style={{ display: "flex", justifyContent: "center" }}
      >
        <span
          style={{
            fontSize: "10px",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: "20px",
            background: stat.workflow.isActive
              ? "hsla(150,75%,40%,.12)"
              : "hsla(225,12%,40%,.1)",
            color: stat.workflow.isActive
              ? "hsl(150,75%,45%)"
              : "var(--text-muted)",
            border: stat.workflow.isActive
              ? "1px solid hsla(150,75%,40%,.25)"
              : "1px solid var(--border-color)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {stat.workflow.isActive ? "Active" : "Off"}
        </span>
      </div>
    </div>
  );
}

function RecentRecordRow({
  record,
  isLast,
  onClick,
}: {
  record: RecentRecord;
  isLast: boolean;
  onClick: () => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "10px 8px",
        borderBottom: isLast ? "none" : "1px solid var(--border-color)",
        cursor: "pointer",
        transition: "background .1s",
        borderRadius: "4px",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      {/* state dot */}
      <div
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: record.color ?? "var(--text-muted)",
          flexShrink: 0,
        }}
      />
      {/* title + workflow name */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {record.title}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {record.workflowName}
        </div>
      </div>
      {/* assignee avatar */}
      {record.assigneeLabel && (
        <span
          title={record.assigneeLabel}
          style={{
            width: "20px",
            height: "20px",
            borderRadius: "50%",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "10px",
            fontWeight: 700,
            color: "var(--text-secondary)",
            flexShrink: 0,
          }}
        >
          {record.assigneeLabel.slice(0, 1).toUpperCase()}
        </span>
      )}
      {/* state badge */}
      {record.state && (
        <span
          style={{
            fontSize: "11px",
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: "20px",
            background: record.color
              ? `${record.color}18`
              : "var(--bg-tertiary)",
            color: record.color ?? "var(--text-muted)",
            border: `1px solid ${record.color ?? "var(--border-color)"}33`,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {record.state}
        </span>
      )}
      {/* date */}
      {record.createdAt && (
        <span
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
            flexShrink: 0,
            marginLeft: "4px",
          }}
        >
          {relativeTime(record.createdAt)}
        </span>
      )}
    </div>
  );
}

function SummaryLinkRow({
  icon,
  label,
  value,
  loading,
  onClick,
}: {
  icon: string;
  label: string;
  value: number;
  loading: boolean;
  onClick: () => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 6px",
        borderBottom: "1px solid var(--border-color)",
        cursor: "pointer",
        transition: "background .1s",
        borderRadius: "4px",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      <span style={{ fontSize: "16px", flexShrink: 0 }}>{icon}</span>
      <span
        style={{
          flex: 1,
          fontSize: "13px",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: "14px",
          fontWeight: 700,
          color: "var(--text-primary)",
        }}
      >
        {loading ? "—" : value}
      </span>
    </div>
  );
}

function QuickActionButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}): React.ReactElement {
  const buttonHover = useHoverStyle({
    base: {
      borderColor: TOKENS.borderColor,
      color: TOKENS.textSecondary,
      background: TOKENS.bgSecondary,
    },
    hover: {
      borderColor: TOKENS.accentPrimary,
      color: TOKENS.accentPrimary,
      background: "hsla(250,84%,60%,.06)",
    },
  });

  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "9px 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid",
        fontSize: "13px",
        fontWeight: 500,
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color .12s, color .12s, background .12s",
        width: "100%",
        ...buttonHover.style,
      }}
      onMouseEnter={buttonHover.onMouseEnter}
      onMouseLeave={buttonHover.onMouseLeave}
    >
      <span style={{ fontSize: "15px" }}>{icon}</span>
      {label}
      <span
        style={{
          marginLeft: "auto",
          color: "var(--text-muted)",
          fontSize: "14px",
        }}
      >
        →
      </span>
    </button>
  );
}

// ── main Dashboard ────────────────────────────────────────────────────────────

export function Dashboard(): React.ReactElement {
  const navigate = useNavigate();
  const { data: identity } = useGetIdentity<{
    id: string;
    name: string;
    email: string;
  }>();

  const [stats, setStats] = useState<WorkflowStat[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<string[]>([]);

  useEffect(() => {
    void userManager.getUser().then((u) => {
      const profile = u?.profile as Record<string, unknown> | undefined;
      const rolesMap = (profile?.["urn:zitadel:iam:org:project:roles"] ??
        {}) as Record<string, unknown>;
      const r = Object.keys(rolesMap);
      setRoles(r);
      const isCustomer =
        (r.includes("user") || r.includes("customer")) &&
        !r.includes("admin") &&
        !r.includes("agent");
      if (isCustomer) navigate("/records", { replace: true });
    });
  }, [navigate]);

  useEffect(() => {
    Promise.all([
      fetchWithAuth(`${API_URL}/workflows`),
      fetchWithAuth(`${API_URL}/modules`),
      fetchWithAuth(`${API_URL}/users`).catch(() => ({ data: [] })),
    ])
      .then(async ([wfRes, modRes, usersRes]) => {
        const workflows = (wfRes as { data?: Workflow[] }).data ?? [];
        const mods = (modRes as { data?: Module[] }).data ?? [];
        setModules(mods);
        setUsers((usersRes as { data?: OrgUser[] }).data ?? []);

        const wfStats = await Promise.all(
          workflows.map(async (wf) => {
            try {
              const recRes = await fetchWithAuth(
                `${API_URL}/entities?entityTypeId=${wf.entityTypeId}`,
              );
              const records = (recRes as { data?: EntityRecord[] }).data ?? [];
              const terminalNames = new Set(
                wf.states.filter((s) => s.isTerminal).map((s) => s.name),
              );
              const open = records.filter(
                (r) => !terminalNames.has(r.currentState ?? ""),
              ).length;
              const closed = records.length - open;
              return {
                workflow: wf,
                total: records.length,
                open,
                closed,
                records,
              };
            } catch {
              return {
                workflow: wf,
                total: 0,
                open: 0,
                closed: 0,
                records: [],
              };
            }
          }),
        );
        setStats(wfStats);
      })
      .catch(() => setStats([]))
      .finally(() => setLoading(false));
  }, []);

  const totalRecords = stats.reduce((sum, s) => sum + s.total, 0);
  const totalOpen = stats.reduce((sum, s) => sum + s.open, 0);
  const totalClosed = stats.reduce((sum, s) => sum + s.closed, 0);
  const installedCount = modules.filter((m) => m.installed).length;
  const firstName = (identity?.name ?? "Admin").split(" ")[0] ?? "Admin";
  const activeWorkflows = stats.filter((s) => s.workflow.isActive).length;

  // recent records across all workflows (latest 8)
  const recentRecords: RecentRecord[] = stats
    .flatMap((s) =>
      s.records.map((r) => {
        const assignee = r.assignedTo
          ? (users.find((u) => u.userId === r.assignedTo) ?? null)
          : null;
        return {
          title: recordTitle(r),
          workflowName: s.workflow.name,
          workflowSlug: slugify(s.workflow.name),
          state: r.currentState,
          color:
            s.workflow.states.find((st) => st.name === r.currentState)?.color ??
            null,
          createdAt: r.createdAt,
          assigneeLabel: r.assignedTo
            ? (assignee?.displayName ?? assignee?.email ?? "Unknown")
            : null,
        };
      }),
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 8);

  // last-7-days sparkline for total record creation
  const allRecords = stats.flatMap((s) => s.records);
  const sparkTotal = dailyCounts(allRecords, 7);
  const createdToday = sparkTotal[sparkTotal.length - 1] ?? 0;

  // aggregate open records by state (top 5 + "Other") for the donut
  const stateAgg = new Map<
    string,
    { label: string; value: number; color: string }
  >();
  for (const s of stats) {
    for (const r of s.records) {
      const st = s.workflow.states.find((x) => x.name === r.currentState);
      if (!st || st.isTerminal) continue;
      const key = `${s.workflow.id}:${st.name}`;
      const color = st.color ?? "var(--accent-primary)";
      const existing = stateAgg.get(key);
      if (existing) existing.value += 1;
      else stateAgg.set(key, { label: st.label, value: 1, color });
    }
  }
  const sortedStates = [...stateAgg.values()].sort((a, b) => b.value - a.value);
  const donutSegments =
    sortedStates.length > 6
      ? [
          ...sortedStates.slice(0, 5),
          {
            label: "Other",
            value: sortedStates.slice(5).reduce((sum, s) => sum + s.value, 0),
            color: "var(--text-muted)",
          },
        ]
      : sortedStates;

  // records past their state's SLA — sorted by how overdue they are
  type OverdueRecord = {
    id: string;
    title: string;
    workflowSlug: string;
    stateLabel: string;
    color: string | null;
    overdueHours: number;
  };
  const needsAttention: OverdueRecord[] = stats
    .flatMap((s) =>
      s.records.flatMap((r) => {
        const st = s.workflow.states.find((x) => x.name === r.currentState);
        if (!st || st.isTerminal || !st.slaHours) return [];
        const since = r.updatedAt ?? r.createdAt;
        if (!since) return [];
        const hoursIn = (Date.now() - new Date(since).getTime()) / 3_600_000;
        const overdueHours = hoursIn - st.slaHours;
        if (overdueHours <= 0) return [];
        return [
          {
            id: r.id,
            title: recordTitle(r),
            workflowSlug: slugify(s.workflow.name),
            stateLabel: st.label,
            color: st.color,
            overdueHours,
          },
        ];
      }),
    )
    .sort((a, b) => b.overdueHours - a.overdueHours)
    .slice(0, 5);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
      {/* ── Page header ───────────────────────────────────────────── */}
      <div
        className="dash-header"
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-md)",
          padding: "20px 24px",
          marginBottom: "20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.07em",
              marginBottom: "4px",
            }}
          >
            {getTodayLabel()}
          </div>
          <h2
            style={{
              fontSize: "20px",
              fontWeight: 700,
              fontFamily: "var(--font-heading)",
              margin: 0,
            }}
          >
            Welcome back, {firstName}
          </h2>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-muted)",
              margin: "2px 0 0",
            }}
          >
            Platform overview — workflows, records & installed modules.
          </p>
        </div>
        <div
          className="dash-header-actions"
          style={{ display: "flex", gap: "8px", flexShrink: 0 }}
        >
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate("/workflows/new")}
          >
            + New Workflow
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate("/modules")}
          >
            Browse Modules
          </Button>
        </div>
      </div>

      {/* ── KPI strip ────────────────────────────────────────────── */}
      <div
        className="dash-kpi"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "14px",
          marginBottom: "20px",
        }}
      >
        <KpiCard
          label="Total Workflows"
          value={loading ? "—" : stats.length}
          sub={`${activeWorkflows} active`}
          icon="⟳"
          color="hsl(211,100%,45%)"
          onClick={() => navigate("/workflows")}
        />
        <KpiCard
          label="Total Records"
          value={loading ? "—" : totalRecords}
          sub={
            createdToday > 0 ? `+${createdToday} today` : "across all workflows"
          }
          icon="📋"
          color="hsl(265,84%,60%)"
          onClick={() => navigate("/records")}
          {...(loading ? {} : { spark: sparkTotal })}
        />
        <KpiCard
          label="Open / In-Progress"
          value={loading ? "—" : totalOpen}
          sub={
            needsAttention.length > 0
              ? `${needsAttention.length} overdue`
              : totalClosed > 0
                ? `${totalClosed} resolved`
                : "none resolved yet"
          }
          icon="🔄"
          color={
            needsAttention.length > 0 ? "hsl(350,80%,60%)" : "hsl(35,90%,50%)"
          }
          onClick={() => navigate("/records")}
        />
        <KpiCard
          label="Installed Modules"
          value={loading ? "—" : installedCount}
          sub={`of ${modules.length} available`}
          icon="🧩"
          color="hsl(150,75%,40%)"
          onClick={() => navigate("/modules")}
        />
      </div>

      {/* ── Two-column body ───────────────────────────────────────── */}
      <div
        className="dash-body"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 320px",
          gap: "14px",
          alignItems: "start",
        }}
      >
        {/* ── Left column ─────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            minWidth: 0,
          }}
        >
          {/* Workflow performance panel */}
          <div
            className="data-panel"
            style={{ padding: "22px 24px", marginBottom: 0 }}
          >
            <SectionHeader
              title="Workflow Performance"
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  style={{
                    border: "1px solid var(--border-color)",
                    color: "var(--text-muted)",
                    borderRadius: "var(--radius-sm)",
                    padding: "4px 10px",
                    fontSize: "12px",
                  }}
                  onClick={() => navigate("/workflows")}
                >
                  View all →
                </Button>
              }
            />

            {loading ? (
              <div className="loading-center" style={{ height: "160px" }}>
                <div
                  className="spinner"
                  style={{ width: "32px", height: "32px", marginBottom: 0 }}
                />
              </div>
            ) : stats.length === 0 ? (
              <div className="empty-state-inline" style={{ padding: "40px 0" }}>
                No workflows yet.{" "}
                <span
                  style={{ color: "var(--accent-primary)", cursor: "pointer" }}
                  onClick={() => navigate("/workflows/new")}
                >
                  Create one →
                </span>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "0" }}
              >
                {/* table header */}
                <div
                  className="dash-perf-head"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 60px 60px 60px 160px 60px",
                    gap: "0 12px",
                    padding: "6px 10px",
                    background: "var(--bg-secondary)",
                    borderRadius: "6px 6px 0 0",
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    borderBottom: "1px solid var(--border-color)",
                  }}
                >
                  <span>Workflow</span>
                  <span
                    className="dash-perf-col-num"
                    style={{ textAlign: "right" }}
                  >
                    Total
                  </span>
                  <span
                    className="dash-perf-col-num"
                    style={{ textAlign: "right" }}
                  >
                    Open
                  </span>
                  <span
                    className="dash-perf-col-num"
                    style={{ textAlign: "right" }}
                  >
                    Done
                  </span>
                  <span
                    className="dash-perf-col-bar"
                    style={{ paddingLeft: "4px" }}
                  >
                    Completion
                  </span>
                  <span
                    className="dash-perf-col-status"
                    style={{ textAlign: "center" }}
                  >
                    Status
                  </span>
                </div>

                {/* rows */}
                {stats.map((s, i) => (
                  <WorkflowPerfRow
                    key={s.workflow.id}
                    stat={s}
                    index={i}
                    onClick={() =>
                      navigate(`/workflows/${slugify(s.workflow.name)}/records`)
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* Recent activity panel */}
          <div
            className="data-panel"
            style={{ padding: "22px 24px", marginBottom: 0 }}
          >
            <SectionHeader
              title="Recent Records"
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  style={{
                    border: "1px solid var(--border-color)",
                    color: "var(--text-muted)",
                    borderRadius: "var(--radius-sm)",
                    padding: "4px 10px",
                    fontSize: "12px",
                  }}
                  onClick={() => navigate("/records")}
                >
                  View all →
                </Button>
              }
            />

            {loading ? (
              <div className="loading-center" style={{ height: "120px" }}>
                <div
                  className="spinner"
                  style={{ width: "28px", height: "28px", marginBottom: 0 }}
                />
              </div>
            ) : recentRecords.length === 0 ? (
              <div className="empty-state-inline">No records created yet.</div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "0" }}
              >
                {recentRecords.map((r, idx) => (
                  <RecentRecordRow
                    key={idx}
                    record={r}
                    isLast={idx === recentRecords.length - 1}
                    onClick={() =>
                      navigate(`/workflows/${r.workflowSlug}/records`)
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right column ─────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* System summary */}
          <div
            className="data-panel"
            style={{ padding: "20px", marginBottom: 0 }}
          >
            <SectionHeader title="System Summary" />
            <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
              {[
                {
                  label: "Workflows",
                  value: stats.length,
                  icon: "⟳",
                  link: "/workflows",
                },
                {
                  label: "Total Records",
                  value: totalRecords,
                  icon: "📋",
                  link: "/records",
                },
                {
                  label: "Modules Available",
                  value: modules.length,
                  icon: "🧩",
                  link: "/modules",
                },
                {
                  label: "Modules Installed",
                  value: installedCount,
                  icon: "✅",
                  link: "/modules",
                },
              ].map((item) => (
                <SummaryLinkRow
                  key={item.label}
                  icon={item.icon}
                  label={item.label}
                  value={item.value}
                  loading={loading}
                  onClick={() => navigate(item.link)}
                />
              ))}
            </div>
          </div>

          {/* Records by state */}
          <div
            className="data-panel"
            style={{ padding: "20px", marginBottom: 0 }}
          >
            <SectionHeader title="Records by State" />
            {loading ? (
              <div className="loading-center" style={{ height: "108px" }}>
                <div
                  className="spinner"
                  style={{ width: "24px", height: "24px", marginBottom: 0 }}
                />
              </div>
            ) : (
              <Donut segments={donutSegments} />
            )}
          </div>

          {/* Quick actions */}
          <div
            className="data-panel"
            style={{ padding: "20px", marginBottom: 0 }}
          >
            <SectionHeader title="Quick Actions" />
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              {[
                { label: "New Workflow", path: "/workflows/new", icon: "+" },
                { label: "Browse Modules", path: "/modules", icon: "🧩" },
                { label: "View Records", path: "/records", icon: "📋" },
              ].map((a) => (
                <QuickActionButton
                  key={a.path}
                  icon={a.icon}
                  label={a.label}
                  onClick={() => navigate(a.path)}
                />
              ))}
            </div>
          </div>

          {/* Roles */}
          {roles.length > 0 && (
            <div
              className="data-panel"
              style={{ padding: "20px", marginBottom: 0 }}
            >
              <SectionHeader title="Your Roles" />
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {roles.map((r) => (
                  <span
                    key={r}
                    className="badge badge-primary"
                    style={{ fontSize: "11px" }}
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Needs attention — records past their state's SLA */}
          <div
            className="data-panel"
            style={{ padding: "20px", marginBottom: 0 }}
          >
            <SectionHeader
              title="Needs Attention"
              action={
                needsAttention.length > 0 ? (
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "20px",
                      background: "hsla(350,80%,60%,.12)",
                      color: "hsl(350,80%,60%)",
                      border: "1px solid hsla(350,80%,60%,.25)",
                    }}
                  >
                    {needsAttention.length} overdue
                  </span>
                ) : undefined
              }
            />
            {loading ? (
              <div className="loading-center" style={{ height: "80px" }}>
                <div
                  className="spinner"
                  style={{ width: "24px", height: "24px", marginBottom: 0 }}
                />
              </div>
            ) : needsAttention.length === 0 ? (
              <div className="empty-state-inline" style={{ padding: "8px 0" }}>
                Nothing overdue — all records are within SLA. ✅
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "0" }}
              >
                {needsAttention.map((o, idx) => (
                  <div
                    key={o.id}
                    onClick={() =>
                      navigate(`/workflows/${o.workflowSlug}/records`)
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "8px 4px",
                      borderBottom:
                        idx < needsAttention.length - 1
                          ? "1px solid var(--border-color)"
                          : "none",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: "7px",
                        height: "7px",
                        borderRadius: "50%",
                        background: "hsl(350,80%,60%)",
                        flexShrink: 0,
                      }}
                    />
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
                        {o.title}
                      </div>
                      <div
                        style={{ fontSize: "11px", color: "var(--text-muted)" }}
                      >
                        {o.stateLabel}
                      </div>
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "hsl(350,80%,60%)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {Math.round(o.overdueHours)}h over
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
