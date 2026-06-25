import React, { useEffect, useState } from "react";
import { useGetIdentity } from "@refinedev/core";
import { useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager } from "../authProvider.js";

type WorkflowState = {
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
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
  fields?: Record<string, unknown>;
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

// ── helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getTodayLabel(): string {
  return new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: string;
  color: string;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <div
      onClick={onClick}
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-color)",
        borderRadius: "var(--radius-md)",
        padding: "20px 22px",
        cursor: onClick ? "pointer" : "default",
        display: "flex",
        alignItems: "flex-start",
        gap: "16px",
        transition: "border-color .15s, box-shadow .15s",
        position: "relative",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          (e.currentTarget as HTMLDivElement).style.borderColor = color;
          (e.currentTarget as HTMLDivElement).style.boxShadow =
            `0 4px 20px ${color}33`;
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor =
          "var(--border-color)";
        (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
      }}
    >
      {/* left accent strip */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: "3px",
          background: color,
          borderRadius: "var(--radius-md) 0 0 var(--radius-md)",
        }}
      />
      {/* icon */}
      <div
        style={{
          width: "44px",
          height: "44px",
          borderRadius: "10px",
          background: `${color}18`,
          border: `1px solid ${color}33`,
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
      <div style={{ flex: 1 }}>
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
    ])
      .then(async ([wfRes, modRes]) => {
        const workflows = (wfRes as { data?: Workflow[] }).data ?? [];
        const mods = (modRes as { data?: Module[] }).data ?? [];
        setModules(mods);

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
  type RecentRecord = {
    workflowName: string;
    workflowSlug: string;
    state: string | null;
    color: string | null;
    createdAt: string | undefined;
  };
  const recentRecords: RecentRecord[] = stats
    .flatMap((s) =>
      s.records.map((r) => ({
        workflowName: s.workflow.name,
        workflowSlug: slugify(s.workflow.name),
        state: r.currentState,
        color:
          s.workflow.states.find((st) => st.name === r.currentState)?.color ??
          null,
        createdAt: r.createdAt,
      })),
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 8);

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
          <button
            className="btn-primary btn-sm"
            onClick={() => navigate("/workflows/new")}
          >
            + New Workflow
          </button>
          <button
            className="btn-secondary btn-sm"
            onClick={() => navigate("/modules")}
          >
            Browse Modules
          </button>
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
          sub="across all workflows"
          icon="📋"
          color="hsl(265,84%,60%)"
          onClick={() => navigate("/records")}
        />
        <KpiCard
          label="Open / In-Progress"
          value={loading ? "—" : totalOpen}
          sub={
            totalClosed > 0 ? `${totalClosed} resolved` : "none resolved yet"
          }
          icon="🔄"
          color="hsl(35,90%,50%)"
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
          gridTemplateColumns: "1fr 320px",
          gap: "14px",
          alignItems: "start",
        }}
      >
        {/* ── Left column ─────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* Workflow performance panel */}
          <div
            className="data-panel"
            style={{ padding: "22px 24px", marginBottom: 0 }}
          >
            <SectionHeader
              title="Workflow Performance"
              action={
                <button
                  className="btn btn-sm"
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
                </button>
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
                {stats.map((s, i) => {
                  const palette = WORKFLOW_COLORS[i % WORKFLOW_COLORS.length];
                  return (
                    <div
                      key={s.workflow.id}
                      className="dash-perf-row"
                      onClick={() =>
                        navigate(
                          `/workflows/${slugify(s.workflow.name)}/records`,
                        )
                      }
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 60px 60px 60px 160px 60px",
                        gap: "0 12px",
                        padding: "12px 10px",
                        borderBottom: "1px solid var(--border-color)",
                        cursor: "pointer",
                        transition: "background .12s",
                        alignItems: "center",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLDivElement).style.background =
                          "var(--bg-secondary)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLDivElement).style.background =
                          "transparent";
                      }}
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
                              background:
                                palette?.accent ?? "var(--accent-primary)",
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
                            {s.workflow.name}
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
                          {s.workflow.states
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
                                  background: st.color
                                    ? `${st.color}1a`
                                    : "var(--bg-tertiary)",
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
                        {s.total}
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
                        {s.open}
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
                        {s.closed}
                      </span>

                      {/* progress */}
                      <div className="dash-perf-col-bar">
                        <ProgressBar
                          value={s.closed}
                          total={s.total}
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
                            background: s.workflow.isActive
                              ? "hsla(150,75%,40%,.12)"
                              : "hsla(225,12%,40%,.1)",
                            color: s.workflow.isActive
                              ? "hsl(150,75%,45%)"
                              : "var(--text-muted)",
                            border: s.workflow.isActive
                              ? "1px solid hsla(150,75%,40%,.25)"
                              : "1px solid var(--border-color)",
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {s.workflow.isActive ? "Active" : "Off"}
                        </span>
                      </div>
                    </div>
                  );
                })}
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
                <button
                  className="btn btn-sm"
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
                </button>
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
                  <div
                    key={idx}
                    onClick={() =>
                      navigate(`/workflows/${r.workflowSlug}/records`)
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "10px 8px",
                      borderBottom:
                        idx < recentRecords.length - 1
                          ? "1px solid var(--border-color)"
                          : "none",
                      cursor: "pointer",
                      transition: "background .1s",
                      borderRadius: "4px",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background =
                        "var(--bg-secondary)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background =
                        "transparent";
                    }}
                  >
                    {/* state dot */}
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: r.color ?? "var(--text-muted)",
                        flexShrink: 0,
                      }}
                    />
                    {/* workflow name */}
                    <span
                      style={{
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.workflowName}
                    </span>
                    {/* state badge */}
                    {r.state && (
                      <span
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "2px 8px",
                          borderRadius: "20px",
                          background: r.color
                            ? `${r.color}18`
                            : "var(--bg-tertiary)",
                          color: r.color ?? "var(--text-muted)",
                          border: `1px solid ${r.color ?? "var(--border-color)"}33`,
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        {r.state}
                      </span>
                    )}
                    {/* date */}
                    {r.createdAt && (
                      <span
                        style={{
                          fontSize: "11px",
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                          marginLeft: "4px",
                        }}
                      >
                        {formatDate(r.createdAt)}
                      </span>
                    )}
                  </div>
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
                <div
                  key={item.label}
                  onClick={() => navigate(item.link)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 6px",
                    borderBottom: "1px solid var(--border-color)",
                    cursor: "pointer",
                    transition: "background .1s",
                    borderRadius: "4px",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "var(--bg-secondary)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "transparent";
                  }}
                >
                  <span style={{ fontSize: "16px", flexShrink: 0 }}>
                    {item.icon}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: "13px",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {item.label}
                  </span>
                  <span
                    style={{
                      fontSize: "14px",
                      fontWeight: 700,
                      color: "var(--text-primary)",
                    }}
                  >
                    {loading ? "—" : item.value}
                  </span>
                </div>
              ))}
            </div>
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
                <button
                  key={a.path}
                  onClick={() => navigate(a.path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "9px 12px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border-color)",
                    color: "var(--text-secondary)",
                    fontSize: "13px",
                    fontWeight: 500,
                    cursor: "pointer",
                    textAlign: "left",
                    transition:
                      "border-color .12s, color .12s, background .12s",
                    width: "100%",
                  }}
                  onMouseEnter={(e) => {
                    const el = e.currentTarget;
                    el.style.borderColor = "var(--accent-primary)";
                    el.style.color = "var(--accent-primary)";
                    el.style.background = "hsla(250,84%,60%,.06)";
                  }}
                  onMouseLeave={(e) => {
                    const el = e.currentTarget;
                    el.style.borderColor = "var(--border-color)";
                    el.style.color = "var(--text-secondary)";
                    el.style.background = "var(--bg-secondary)";
                  }}
                >
                  <span style={{ fontSize: "15px" }}>{a.icon}</span>
                  {a.label}
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

          {/* Platform status */}
          <div
            className="data-panel"
            style={{ padding: "20px", marginBottom: 0 }}
          >
            <SectionHeader title="Platform Status" />
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              {[
                { label: "API Server", ok: true },
                { label: "Workflow Engine", ok: true },
                { label: "Entity Engine", ok: true },
                { label: "Auth (Zitadel)", ok: true },
              ].map((svc) => (
                <div
                  key={svc.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                  }}
                >
                  <div
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "50%",
                      background: svc.ok
                        ? "hsl(150,75%,45%)"
                        : "hsl(350,80%,60%)",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1 }}>{svc.label}</span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: svc.ok ? "hsl(150,75%,45%)" : "hsl(350,80%,60%)",
                    }}
                  >
                    {svc.ok ? "Operational" : "Degraded"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
