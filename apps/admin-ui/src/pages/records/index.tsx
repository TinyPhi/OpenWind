import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";
import type { EntityType } from "../../entity-type-context.js";
import { userManager } from "../../authProvider.js";
import { resolveCardIcon } from "../../lib/icon.js";
import { humanizeWorkflowName } from "../../lib/format.js";

function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Workflow = {
  id: string;
  name: string;
  entityTypeId: string;
  initialState: string;
  recordCount: number;
  states: {
    name: string;
    label: string;
    color: string | null;
    isTerminal: boolean;
  }[];
  transitions: { id: string }[];
};

type MyTicketWorkflow = {
  workflowId: string;
  workflowName: string;
  workflowSlug: string;
  accessibleTicketCount: number;
};

type MyTicketParent = {
  id: string;
  workflowId: string;
  accessReason: "creator" | "assigned" | "mention" | "manual";
};

type FilterChip = "all" | "assigned" | "watching" | "created" | "subtasks";

const FILTER_LABELS: Record<FilterChip, string> = {
  all: "All",
  assigned: "Assigned to me",
  watching: "Watching",
  created: "I created",
  subtasks: "Sub-tasks",
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CARD_GRADIENTS = [
  "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
  "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  "linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function reasonMatchesFilter(
  reason: MyTicketParent["accessReason"],
  filter: FilterChip,
): boolean {
  if (filter === "all") return true;
  if (filter === "assigned") return reason === "assigned";
  if (filter === "watching") return reason === "mention";
  if (filter === "created") return reason === "creator";
  return false;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AdminRecords(): React.ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { entityTypes } = useEntityTypes();

  const [currentUserRoles, setCurrentUserRoles] = useState<string[]>([]);
  const [userLoaded, setUserLoaded] = useState(false);

  // Admin/agent path
  const [workflows, setWorkflows] = useState<Workflow[]>([]);

  // User path
  const [myWorkflows, setMyWorkflows] = useState<MyTicketWorkflow[]>([]);
  const [myParents, setMyParents] = useState<MyTicketParent[]>([]);
  const [myChildWorkflowIds, setMyChildWorkflowIds] = useState<Set<string>>(
    new Set(),
  );

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const activeFilter =
    (searchParams.get("filter") as FilterChip | null) ?? "all";

  const isUser =
    userLoaded &&
    !currentUserRoles.includes("admin") &&
    !currentUserRoles.includes("agent");

  // ── Load user role ────────────────────────────────────────────────────────

  useEffect(() => {
    void userManager.getUser().then((u) => {
      if (!u) {
        setUserLoaded(true);
        return;
      }
      const roleClaim = u.profile["urn:zitadel:iam:org:project:roles"] as
        | Record<string, unknown>
        | undefined;
      const roles = roleClaim ? Object.keys(roleClaim) : [];
      setCurrentUserRoles(roles);
      setUserLoaded(true);
    });
  }, []);

  // ── Fetch data once role is known ─────────────────────────────────────────

  useEffect(() => {
    if (!userLoaded) return;

    if (!isUser) {
      // Admin / agent — fetch all workflows
      fetchWithAuth(`${API_URL}/workflows`)
        .then((res) => setWorkflows((res as { data?: Workflow[] }).data ?? []))
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Failed to load"),
        )
        .finally(() => setLoading(false));
    } else {
      // General user — fetch only their accessible tickets
      fetchWithAuth(`${API_URL}/entities/my-tickets`)
        .then((res) => {
          const d =
            (
              res as {
                data?: {
                  workflows?: MyTicketWorkflow[];
                  parentTickets?: MyTicketParent[];
                  childTickets?: { workflowId: string }[];
                };
              }
            ).data ?? {};
          setMyWorkflows(d.workflows ?? []);
          setMyParents(d.parentTickets ?? []);
          setMyChildWorkflowIds(
            new Set((d.childTickets ?? []).map((c) => c.workflowId)),
          );
        })
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "Failed to load"),
        )
        .finally(() => setLoading(false));
    }
  }, [userLoaded, isUser]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const etMap = new Map(entityTypes.map((e) => [e.id, e]));

  function setFilter(f: FilterChip): void {
    setSearchParams(f === "all" ? {} : { filter: f });
  }

  // For general users: filter which workflow cards to show based on active chip
  const visibleMyWorkflows = myWorkflows.filter((wf) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "subtasks")
      return myChildWorkflowIds.has(wf.workflowId);
    // Check if any parent ticket in this workflow matches the filter
    return myParents.some(
      (p) =>
        p.workflowId === wf.workflowId &&
        reasonMatchesFilter(p.accessReason, activeFilter),
    );
  });

  const searchTerm = search.trim().toLowerCase();
  const filteredWorkflows = workflows.filter((wf) =>
    humanizeWorkflowName(wf.name).toLowerCase().includes(searchTerm),
  );
  const searchedMyWorkflows = visibleMyWorkflows.filter((wf) =>
    humanizeWorkflowName(wf.workflowName).toLowerCase().includes(searchTerm),
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (!userLoaded || loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading records…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-icon">⚠</div>
        <h4>Failed to load</h4>
        <p>{error}</p>
      </div>
    );
  }

  // ── Admin / agent view ────────────────────────────────────────────────────

  if (!isUser) {
    return (
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            marginBottom: "28px",
          }}
        >
          <div>
            <h2 className="page-title">Records</h2>
            <p className="page-subtitle">
              Browse all workflow record types. Click a card to view and manage
              its records.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <div className="stat-pill">{workflows.length} workflows</div>
          </div>
        </div>

        {workflows.length > 0 && (
          <input
            type="text"
            className="mod-search"
            placeholder="Search workflows by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", maxWidth: "360px", marginBottom: "20px" }}
          />
        )}

        {workflows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📋</div>
            <h4>No workflows yet</h4>
            <p>Create a workflow to start tracking records.</p>
            <button
              className="btn-primary"
              style={{ marginTop: "16px" }}
              onClick={() => navigate("/workflows/new")}
            >
              + New Workflow
            </button>
          </div>
        ) : filteredWorkflows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <h4>No matches</h4>
            <p>No workflows match "{search}".</p>
          </div>
        ) : (
          <WorkflowCardGrid
            items={filteredWorkflows.map((wf, i) => ({
              id: wf.id,
              name: humanizeWorkflowName(wf.name),
              entityTypeId: wf.entityTypeId,
              slug: toWorkflowSlug(wf.name),
              gradient: CARD_GRADIENTS[i % CARD_GRADIENTS.length] ?? "",
              count: wf.recordCount,
              countLabel: "record",
              states: wf.states,
              transitionCount: wf.transitions.length,
              etMap,
            }))}
            onNavigate={(slug) => navigate(`/workflows/${slug}/records`)}
          />
        )}
      </div>
    );
  }

  // ── General user view ─────────────────────────────────────────────────────

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "20px",
        }}
      >
        <div>
          <h2 className="page-title">My Records</h2>
          <p className="page-subtitle">
            Workflows where you have open tickets.
          </p>
        </div>
        <div className="stat-pill">{visibleMyWorkflows.length} workflows</div>
      </div>

      {/* Filter chips */}
      <div
        style={{
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
          marginBottom: "24px",
        }}
      >
        {(Object.keys(FILTER_LABELS) as FilterChip[]).map((chip) => (
          <button
            key={chip}
            onClick={() => setFilter(chip)}
            style={{
              padding: "5px 14px",
              borderRadius: "20px",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              border:
                activeFilter === chip
                  ? "1.5px solid var(--accent-primary)"
                  : "1.5px solid var(--border-color)",
              background:
                activeFilter === chip
                  ? "var(--accent-primary)"
                  : "var(--bg-secondary)",
              color: activeFilter === chip ? "#fff" : "var(--text-secondary)",
              transition: "all .15s",
            }}
          >
            {FILTER_LABELS[chip]}
          </button>
        ))}
      </div>

      {visibleMyWorkflows.length > 0 && (
        <input
          type="text"
          className="mod-search"
          placeholder="Search workflows by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: "100%", maxWidth: "360px", marginBottom: "20px" }}
        />
      )}

      {visibleMyWorkflows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <h4>No records here</h4>
          <p>
            {activeFilter === "all"
              ? "You have no tickets assigned to you yet."
              : `No tickets match the "${FILTER_LABELS[activeFilter]}" filter.`}
          </p>
        </div>
      ) : searchedMyWorkflows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <h4>No matches</h4>
          <p>No workflows match "{search}".</p>
        </div>
      ) : (
        <WorkflowCardGrid
          items={searchedMyWorkflows.map((wf, i) => ({
            id: wf.workflowId,
            name: humanizeWorkflowName(wf.workflowName),
            entityTypeId: "",
            slug: wf.workflowSlug,
            gradient: CARD_GRADIENTS[i % CARD_GRADIENTS.length] ?? "",
            count: wf.accessibleTicketCount,
            countLabel: "ticket",
            states: [],
            transitionCount: 0,
            etMap,
            ...(activeFilter !== "all" && { filterParam: activeFilter }),
          }))}
          onNavigate={(slug, filterParam) => {
            const url = filterParam
              ? `/workflows/${slug}/records?filter=${filterParam}`
              : `/workflows/${slug}/records`;
            navigate(url);
          }}
        />
      )}
    </div>
  );
}

// ── Shared card grid ──────────────────────────────────────────────────────────

type CardItem = {
  id: string;
  name: string;
  entityTypeId: string;
  slug: string;
  gradient: string;
  count: number;
  countLabel: string;
  states: {
    name: string;
    label: string;
    color: string | null;
    isTerminal: boolean;
  }[];
  transitionCount: number;
  etMap: Map<string, EntityType>;
  filterParam?: string;
};

function WorkflowCardGrid({
  items,
  onNavigate,
}: {
  items: CardItem[];
  onNavigate: (slug: string, filterParam?: string) => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: "20px",
      }}
    >
      {items.map((item) => {
        const et = item.etMap.get(item.entityTypeId);
        const activeStates = item.states.filter((s) => !s.isTerminal);
        const terminalStates = item.states.filter((s) => s.isTerminal);

        return (
          <div
            key={item.id}
            onClick={() => onNavigate(item.slug, item.filterParam)}
            style={{
              height: "320px",
              display: "flex",
              flexDirection: "column",
              borderRadius: "16px",
              overflow: "hidden",
              cursor: "pointer",
              border: "1px solid var(--border-color)",
              background: "var(--bg-secondary)",
              transition: "transform .15s, box-shadow .15s",
              boxShadow: "var(--shadow-sm)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.transform =
                "translateY(-3px)";
              (e.currentTarget as HTMLDivElement).style.boxShadow =
                "var(--shadow-lg)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.transform =
                "translateY(0)";
              (e.currentTarget as HTMLDivElement).style.boxShadow =
                "var(--shadow-sm)";
            }}
          >
            {/* Gradient header — fixed height, top half */}
            <div
              style={{
                height: "160px",
                flexShrink: 0,
                background: item.gradient,
                padding: "24px 24px 20px",
                position: "relative",
                overflow: "hidden",
              }}
            >
              {item.count > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: "12px",
                    right: "12px",
                    background: "rgba(255,255,255,.25)",
                    backdropFilter: "blur(4px)",
                    borderRadius: "20px",
                    padding: "2px 10px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "#fff",
                  }}
                >
                  {item.count} {item.countLabel}
                  {item.count !== 1 ? "s" : ""}
                </div>
              )}
              <div style={{ fontSize: "32px", marginBottom: "8px" }}>
                {resolveCardIcon(et?.icon)}
              </div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: 700,
                  color: "#fff",
                  lineHeight: 1.2,
                }}
              >
                {item.name}
              </div>
              {item.states.length > 0 && (
                <div
                  style={{
                    fontSize: "12px",
                    color: "rgba(255,255,255,.75)",
                    marginTop: "4px",
                  }}
                >
                  {item.states.length} states · {item.transitionCount}{" "}
                  transitions
                </div>
              )}
            </div>

            {/* Card body — bottom half, fills remaining fixed height */}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                padding: "16px 20px 20px",
                overflow: "hidden",
              }}
            >
              {item.states.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: "6px",
                    flexWrap: "wrap",
                    marginBottom: "16px",
                  }}
                >
                  {activeStates.slice(0, 4).map((s) => (
                    <span
                      key={s.name}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "20px",
                        fontSize: "11px",
                        fontWeight: 500,
                        background: s.color
                          ? `${s.color}22`
                          : "var(--bg-tertiary)",
                        color: s.color ?? "var(--text-muted)",
                        border: `1px solid ${s.color ? `${s.color}44` : "var(--border-color)"}`,
                      }}
                    >
                      <span
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: s.color ?? "var(--text-muted)",
                          flexShrink: 0,
                        }}
                      />
                      {s.label}
                    </span>
                  ))}
                  {terminalStates.length > 0 && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "2px 8px",
                        borderRadius: "20px",
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        background: "var(--bg-tertiary)",
                        border: "1px solid var(--border-color)",
                      }}
                    >
                      ⬡ {terminalStates[0]?.label}
                    </span>
                  )}
                </div>
              )}

              <button
                className="btn-primary"
                style={{
                  width: "100%",
                  justifyContent: "center",
                  marginTop: "auto",
                  flexShrink: 0,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigate(item.slug, item.filterParam);
                }}
              >
                View Records →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
