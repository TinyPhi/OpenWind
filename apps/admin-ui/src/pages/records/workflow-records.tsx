import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  useParams,
  Link,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes, toTypeSlug } from "../../entity-type-context.js";
import { userManager } from "../../authProvider.js";
import { isRenderableIcon } from "../../lib/icon.js";
import { humanizeWorkflowName } from "../../lib/format.js";
import { TransitionModal } from "../../components/transition-modal.js";
import {
  OriginCornerBadge,
  COLOR_BY_MECHANISM,
  LABEL_BY_MECHANISM,
  type Origin,
} from "../../components/origin-tag.js";
import {
  SeverityBadge,
  SEVERITY_LEVELS,
  SEVERITY_LABEL,
  SEVERITY_COLOR,
  type Severity,
} from "../../components/severity-tag.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isSystem: boolean;
  config: {
    options?: Array<string | { label: string; value: string; color?: string }>;
  };
};
type EntityInstance = {
  id: string;
  currentState: string | null;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignedTo?: string | null;
  // docs/specs/third-party-api-origin-tagging.md — resolved server-side by
  // apps/api/src/lib/resolve-origin-display.ts. Absent/null = normal,
  // human, in-app creation, no tag rendered.
  origin?: Origin;
  // docs/specs/ticket-severity-and-tags.md — null only on tickets created
  // before this feature shipped (§V).
  severity?: Severity | null;
};
type OrgUser = {
  userId: string;
  email: string;
  displayName: string | null;
};
type WorkflowState = {
  id: string;
  name: string;
  label: string;
  color?: string | null;
};
type Transition = {
  id: string;
  fromState: string;
  toState: string;
  label: string;
  requiresComment: boolean;
  requiresFields: string[];
};
type ChildTicket = {
  id: string;
  parentId: string;
  parentCurrentState: string | null;
  workflowId: string;
  fields: Record<string, unknown>;
  assignedTo: string | null;
  createdAt: string;
  accessReason: "assigned" | "mention" | "manual";
  origin?: Origin;
  severity?: Severity | null;
};

function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

// ── Module-level drag state ────────────────────────────────────────────────────
let _activeDragType: "card" | "column" | null = null;
let _activeDragId: string | null = null;
let _activeDragCol: string | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

function fieldDisplay(value: unknown, fieldType: string): string {
  if (value === null || value === undefined) return "";
  if (fieldType === "boolean") return String(value) === "true" ? "Yes" : "No";
  if (fieldType === "date" || fieldType === "datetime") {
    const d = new Date(value as string);
    return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString();
  }
  if (fieldType === "currency" && typeof value === "object") {
    const cv = value as { amount?: unknown; currency?: unknown };
    return `${cv.currency ?? ""} ${cv.amount ?? ""}`.trim();
  }
  return String(value);
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

// ── Child Ticket Card ──────────────────────────────────────────────────────────

function ChildTicketCard({
  ticket,
  typeSlug,
  users,
}: {
  ticket: ChildTicket;
  typeSlug: string;
  users: OrgUser[];
}): React.ReactElement {
  const navigate = useNavigate();
  const title =
    String(
      ticket.fields.title ?? ticket.fields.subject ?? ticket.fields.name ?? "",
    ).trim() || `#${ticket.id.slice(0, 8)}`;
  const isDone = String(ticket.fields.child_status ?? "open") === "done";

  const assignee = ticket.assignedTo
    ? (users.find((u) => u.userId === ticket.assignedTo) ?? null)
    : null;
  const assigneeLabel = ticket.assignedTo
    ? (assignee?.displayName ?? assignee?.email ?? "Unknown")
    : "Unassigned";

  return (
    <div
      className="kb-card kb-card--child"
      onClick={() => navigate(`/records/${typeSlug}/${ticket.id}`)}
    >
      <OriginCornerBadge origin={ticket.origin} />

      <div
        className="kb-card-title"
        style={ticket.origin ? { paddingRight: "58px" } : undefined}
      >
        {title}
      </div>

      <div className="kb-card-meta">
        <span className="kb-card-meta-label">State</span>
        <span
          className={`kb-child-status-badge ${isDone ? "kb-child-status-badge--done" : ""}`}
        >
          {isDone ? "✓ Closed" : "○ Open"}
        </span>
      </div>

      {ticket.severity && (
        <div className="kb-card-meta">
          <SeverityBadge severity={ticket.severity} compact />
        </div>
      )}

      <div className="kb-card-footer">
        <span className="kb-card-time">
          Created {relativeTime(ticket.createdAt)}
        </span>
        <span className="kb-card-assignee" title={assigneeLabel}>
          {ticket.assignedTo ? (
            <span className="kb-card-avatar kb-subtask-avatar">
              {assigneeLabel.slice(0, 1).toUpperCase()}
            </span>
          ) : null}
          {assigneeLabel}
        </span>
      </div>
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────────

function RecordCard({
  record,
  fields,
  typeSlug,
  stateLabel,
  users,
}: {
  record: EntityInstance;
  fields: EntityField[];
  typeSlug: string;
  stateLabel?: string | null | undefined;
  users: OrgUser[];
}): React.ReactElement {
  const navigate = useNavigate();
  const divRef = useRef<HTMLDivElement>(null);

  const preview: Array<{ field: EntityField; value: string }> = [];
  for (const f of fields) {
    if (preview.length >= 1) break;
    const v = fieldDisplay(record.fields[f.name], f.fieldType);
    if (v) preview.push({ field: f, value: v });
  }

  const assignee = record.assignedTo
    ? (users.find((u) => u.userId === record.assignedTo) ?? null)
    : null;
  const assigneeLabel = record.assignedTo
    ? (assignee?.displayName ?? assignee?.email ?? "Unknown")
    : "Unassigned";

  return (
    <div
      ref={divRef}
      className="kb-card"
      draggable={true}
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData("text/plain", record.id);
        e.dataTransfer.effectAllowed = "move";
        _activeDragType = "card";
        _activeDragId = record.id;
        requestAnimationFrame(() => {
          divRef.current?.classList.add("kb-card--ghost");
        });
      }}
      onDragEnd={() => {
        _activeDragType = null;
        _activeDragId = null;
        divRef.current?.classList.remove("kb-card--ghost");
      }}
      onClick={() => navigate(`/records/${typeSlug}/${record.id}`)}
    >
      <OriginCornerBadge origin={record.origin} />

      <div
        className="kb-card-title"
        style={record.origin ? { paddingRight: "58px" } : undefined}
      >
        {preview[0]?.value ?? `#${record.id.slice(0, 8)}`}
      </div>

      {stateLabel && (
        <div className="kb-card-meta">
          <span className="kb-card-meta-label">State</span>
          <span className="kb-card-meta-value">{stateLabel}</span>
        </div>
      )}
      {record.severity && (
        <div className="kb-card-meta">
          <SeverityBadge severity={record.severity} compact />
        </div>
      )}

      <div className="kb-card-footer">
        <span className="kb-card-time">
          Created {relativeTime(record.createdAt)}
        </span>
        <span className="kb-card-assignee" title={assigneeLabel}>
          {record.assignedTo ? (
            <span className="kb-card-avatar">
              {assigneeLabel.slice(0, 1).toUpperCase()}
            </span>
          ) : null}
          {assigneeLabel}
        </span>
      </div>
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────────────

type ColDropState = "idle" | "valid" | "blocked" | "reorder";

function KanbanColumn({
  state,
  records,
  fields,
  typeSlug,
  entityTypeId: _entityTypeId,
  workflowId: _workflowId,
  transitions,
  allRecords,
  onCardDrop,
  onColumnDrop,
  childTickets = [],
  users,
}: {
  state: WorkflowState | null;
  records: EntityInstance[];
  fields: EntityField[];
  typeSlug: string;
  entityTypeId: string;
  workflowId: string;
  transitions: Transition[];
  allRecords: EntityInstance[];
  onCardDrop: (recordId: string, toStateName: string) => void;
  onColumnDrop: (fromStateName: string, toStateName: string) => void;
  childTickets?: ChildTicket[];
  users: OrgUser[];
}): React.ReactElement {
  const [dropState, setDropState] = useState<ColDropState>("idle");
  const enterCount = useRef(0);

  function resolveCardDropState(recordId: string | null): "valid" | "blocked" {
    if (!recordId || !state) return "blocked";
    const rec = allRecords.find((r) => r.id === recordId);
    if (!rec || rec.currentState === state.name) return "blocked";
    const ok = transitions.some(
      (t) => t.fromState === rec.currentState && t.toState === state.name,
    );
    return ok ? "valid" : "blocked";
  }

  function handleDragEnter(e: React.DragEvent): void {
    e.preventDefault();
    enterCount.current += 1;
    if (enterCount.current === 1) {
      if (_activeDragType === "column") {
        setDropState(
          _activeDragCol !== (state?.name ?? null) ? "reorder" : "idle",
        );
      } else {
        setDropState(resolveCardDropState(_activeDragId));
      }
    }
  }

  function handleDragLeave(): void {
    enterCount.current = Math.max(0, enterCount.current - 1);
    if (enterCount.current === 0) setDropState("idle");
  }

  function handleDragOver(e: React.DragEvent): void {
    e.preventDefault();
    if (_activeDragType === "column") {
      e.dataTransfer.dropEffect =
        _activeDragCol !== (state?.name ?? null) ? "move" : "none";
    } else {
      e.dataTransfer.dropEffect = dropState === "valid" ? "move" : "none";
    }
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault();
    enterCount.current = 0;
    setDropState("idle");

    if (_activeDragType === "column") {
      const fromCol = _activeDragCol;
      _activeDragType = null;
      _activeDragCol = null;
      if (fromCol && state && fromCol !== state.name) {
        onColumnDrop(fromCol, state.name);
      }
      return;
    }

    const recordId = e.dataTransfer.getData("text/plain") || _activeDragId;
    _activeDragId = null;
    _activeDragType = null;
    if (recordId && state && resolveCardDropState(recordId) === "valid") {
      onCardDrop(recordId, state.name);
    }
  }

  useEffect(() => {
    function onDragEnd(): void {
      enterCount.current = 0;
      setDropState("idle");
    }
    window.addEventListener("dragend", onDragEnd);
    return () => window.removeEventListener("dragend", onDragEnd);
  }, []);

  const accentColor = state?.color ?? "var(--accent-primary)";

  return (
    <div
      className={`kb-col kb-col--${dropState}`}
      style={
        state?.color
          ? {
              background: `color-mix(in srgb, ${state.color} 8%, var(--bg-secondary))`,
            }
          : undefined
      }
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Header — draggable for column reorder */}
      <div
        className="kb-col-header"
        draggable={state !== null}
        onDragStart={(e) => {
          if (!state) return;
          e.stopPropagation();
          e.dataTransfer.setData("application/x-col", state.name);
          e.dataTransfer.effectAllowed = "move";
          _activeDragType = "column";
          _activeDragCol = state.name;
        }}
        onDragEnd={() => {
          _activeDragType = null;
          _activeDragCol = null;
        }}
      >
        <div className="kb-col-header-left">
          <span className="kb-col-drag-handle" title="Drag to reorder">
            <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
              <circle
                cx="3"
                cy="2.5"
                r="1.2"
                fill="currentColor"
                opacity=".5"
              />
              <circle
                cx="7"
                cy="2.5"
                r="1.2"
                fill="currentColor"
                opacity=".5"
              />
              <circle cx="3" cy="7" r="1.2" fill="currentColor" opacity=".5" />
              <circle cx="7" cy="7" r="1.2" fill="currentColor" opacity=".5" />
              <circle
                cx="3"
                cy="11.5"
                r="1.2"
                fill="currentColor"
                opacity=".5"
              />
              <circle
                cx="7"
                cy="11.5"
                r="1.2"
                fill="currentColor"
                opacity=".5"
              />
            </svg>
          </span>
          <span className="kb-col-dot" style={{ background: accentColor }} />
          <span className="kb-col-title">{state?.label ?? "Unassigned"}</span>
        </div>
        <span className="kb-col-count">{records.length}</span>
      </div>

      {/* Cards */}
      <div className="kb-col-body">
        {records.map((rec) => (
          <RecordCard
            key={rec.id}
            record={rec}
            fields={fields}
            typeSlug={typeSlug}
            stateLabel={state?.label}
            users={users}
          />
        ))}

        {records.length === 0 &&
          dropState === "idle" &&
          childTickets.length === 0 && (
            <div className="kb-col-empty">No items</div>
          )}

        {dropState === "valid" && (
          <div className="kb-drop-zone">Drop to move here</div>
        )}

        {dropState === "reorder" && (
          <div className="kb-reorder-zone">Insert column here</div>
        )}

        {/* Sub-tasks — rendered as full cards below parent cards */}
        {childTickets.length > 0 && (
          <div className="kb-subtasks">
            <div className="kb-subtasks-divider">
              <span className="kb-subtasks-label">
                Sub-tasks ({childTickets.length})
              </span>
            </div>
            {childTickets.map((ct) => (
              <ChildTicketCard
                key={ct.id}
                ticket={ct}
                typeSlug={typeSlug}
                users={users}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function WorkflowRecords(): React.ReactElement {
  const { workflowSlug } = useParams<{ workflowSlug: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { getTypeById } = useEntityTypes();

  const activeFilter = searchParams.get("filter") ?? "all";

  const [workflowId, setWorkflowId] = useState<string>("");
  const [entityTypeId, setEntityTypeId] = useState<string>("");
  const [workflowName, setWorkflowName] = useState<string>("");
  const [workflowAssignedTo, setWorkflowAssignedTo] = useState<string[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRoles, setCurrentUserRoles] = useState<string[]>([]);
  const [isUserRole, setIsUserRole] = useState(false);
  const [fields, setFields] = useState<EntityField[]>([]);
  const [records, setRecords] = useState<EntityInstance[]>([]);
  const [childTickets, setChildTickets] = useState<ChildTicket[]>([]);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transError, setTransError] = useState<string | null>(null);

  const [users, setUsers] = useState<OrgUser[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDateField, setFilterDateField] = useState<
    "createdAt" | "updatedAt" | ""
  >("");
  const [filterDateValue, setFilterDateValue] = useState("");
  const [filterAssignedTo, setFilterAssignedTo] = useState("");
  const [filterOrigin, setFilterOrigin] = useState<
    "" | "internal" | "external" | "redirected"
  >("");
  // docs/specs/ticket-severity-and-tags.md T16 — severity + tag + (now)
  // origin all filter server-side, re-fetching on change, rather than
  // client-side over an already-loaded page.
  const [filterSeverities, setFilterSeverities] = useState<Set<Severity>>(
    new Set(),
  );
  const [filterTagInput, setFilterTagInput] = useState("");
  const [filterTag, setFilterTag] = useState(""); // debounced value actually sent to the server
  const filterTagDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  function handleFilterTagInputChange(value: string): void {
    setFilterTagInput(value);
    if (filterTagDebounceRef.current)
      clearTimeout(filterTagDebounceRef.current);
    filterTagDebounceRef.current = setTimeout(() => {
      setFilterTag(value.trim());
    }, 400);
  }
  useEffect(() => {
    return () => {
      if (filterTagDebounceRef.current)
        clearTimeout(filterTagDebounceRef.current);
    };
  }, []);
  const [userSearch, setUserSearch] = useState("");
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);

  const [colOrder, setColOrder] = useState<string[]>([]);

  const [pendingDrop, setPendingDrop] = useState<{
    recordId: string;
    toStateName: string;
    transition: Transition;
  } | null>(null);

  useEffect(() => {
    void userManager.getUser().then((u) => {
      if (!u) return;
      setCurrentUserId(u.profile.sub);
      const roleClaim = u.profile["urn:zitadel:iam:org:project:roles"] as
        | Record<string, unknown>
        | undefined;
      const roles = roleClaim ? Object.keys(roleClaim) : [];
      setCurrentUserRoles(roles);
      setIsUserRole(!roles.includes("admin") && !roles.includes("agent"));
    });
  }, []);

  useEffect(() => {
    if (!workflowSlug) return;
    setLoading(true);
    setError(null);

    // Resolve slug → id via the dedicated, ownership-unfiltered lookup — the
    // ownership-filtered list/summary endpoints only include workflows the
    // caller administers, which would 404 a plain ticket assignee here.
    fetchWithAuth(`${API_URL}/workflows/slugs`)
      .then(async (listRes) => {
        const all =
          (
            listRes as {
              data?: Array<{ id: string; name: string }>;
            }
          ).data ?? [];

        const matched = all.find(
          (w) => toWorkflowSlug(w.name) === workflowSlug,
        );
        if (!matched) throw new Error(`Workflow "${workflowSlug}" not found`);

        // Fetch full workflow detail (states + transitions)
        const wfRes = await fetchWithAuth(`${API_URL}/workflows/${matched.id}`);
        const wf = (
          wfRes as {
            data: {
              id: string;
              name: string;
              entityTypeId: string;
              createdBy: string | null;
              assignedTo: string[] | null;
              states: WorkflowState[];
              transitions: Transition[];
            };
          }
        ).data;

        setWorkflowId(wf.id);
        setWorkflowName(wf.name);
        setEntityTypeId(wf.entityTypeId);
        setWorkflowAssignedTo((wf.assignedTo as string[] | null) ?? []);

        const loadedStates = wf.states as WorkflowState[];
        const loadedTransitions = wf.transitions as Transition[];
        setStates(loadedStates);
        setTransitions(loadedTransitions);
        setColOrder((prev) => {
          if (prev.length === 0) return loadedStates.map((s) => s.name);
          const kept = prev.filter((n) =>
            loadedStates.some((s) => s.name === n),
          );
          const added = loadedStates
            .filter((s) => !prev.includes(s.name))
            .map((s) => s.name);
          return [...kept, ...added];
        });

        // A "user"-role caller who is this workflow's creator or in its
        // assignedTo list is a workflow admin and gets the same unrestricted
        // list access as admin/agent (mirrors apps/api/src/routes/entities/
        // list.ts's isWorkflowAdmin check) - isUserRole alone only reflects
        // the raw admin/agent role, so without this a workflow admin was
        // silently routed through /entities/my-tickets and only ever saw
        // their own tickets.
        const isWorkflowAdminForThisWorkflow =
          isUserRole &&
          currentUserId !== null &&
          (currentUserId === wf.createdBy ||
            ((wf.assignedTo as string[] | null) ?? []).includes(currentUserId));
        const useMyTickets = isUserRole && !isWorkflowAdminForThisWorkflow;

        // docs/specs/ticket-severity-and-tags.md T16 — severity/tag/origin
        // all filter server-side now, shared by both fetch paths (list.ts's
        // own params and my-tickets.ts's mirrored ones).
        const filterParams = new URLSearchParams();
        if (filterSeverities.size > 0) {
          filterParams.set("severity", [...filterSeverities].join(","));
        }
        if (filterTag) {
          filterParams.set("tag", filterTag);
        }
        if (filterOrigin) {
          filterParams.set("origin", filterOrigin);
        }
        const filterQS = filterParams.toString();

        const [fieldsRes, recRes, usersRes] = await Promise.all([
          fetchWithAuth(`${API_URL}/entity-types/${wf.entityTypeId}/fields`),
          useMyTickets
            ? fetchWithAuth(
                `${API_URL}/entities/my-tickets?workflowId=${wf.id}${filterQS ? `&${filterQS}` : ""}`,
              )
            : fetchWithAuth(
                `${API_URL}/entities?entityTypeId=${wf.entityTypeId}&rootOnly=true${filterQS ? `&${filterQS}` : ""}`,
              ),
          fetchWithAuth(`${API_URL}/users`).catch(() => ({ data: [] })),
        ]);
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        if (useMyTickets) {
          const myData =
            (
              recRes as {
                data?: {
                  parentTickets?: EntityInstance[];
                  childTickets?: ChildTicket[];
                };
              }
            ).data ?? {};
          setRecords(myData.parentTickets ?? []);
          setChildTickets(myData.childTickets ?? []);
        } else {
          setRecords((recRes as { data?: EntityInstance[] }).data ?? []);
          setChildTickets([]);
        }
        setUsers((usersRes as { data?: OrgUser[] }).data ?? []);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [workflowSlug, isUserRole, filterSeverities, filterTag, filterOrigin]);

  useEffect(() => {
    if (!searchExpanded) return;
    function onClickOutside(e: MouseEvent): void {
      if (
        searchWrapRef.current &&
        !searchWrapRef.current.contains(e.target as Node)
      ) {
        if (!searchText) setSearchExpanded(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [searchExpanded, searchText]);

  useEffect(() => {
    if (!filterOpen) return;
    function onClickOutside(e: MouseEvent): void {
      if (
        filterPanelRef.current &&
        !filterPanelRef.current.contains(e.target as Node) &&
        filterBtnRef.current &&
        !filterBtnRef.current.contains(e.target as Node)
      ) {
        setFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [filterOpen]);

  const entityType = entityTypeId ? getTypeById(entityTypeId) : undefined;
  const typeSlug = entityType
    ? toTypeSlug(entityType.plural || entityType.name)
    : "";

  const showSettings =
    currentUserId !== null &&
    (currentUserRoles.includes("admin") ||
      (workflowAssignedTo.length > 0 &&
        workflowAssignedTo.includes(currentUserId)));

  const orderedStates: WorkflowState[] = colOrder
    .map((name) => states.find((s) => s.name === name))
    .filter(Boolean) as WorkflowState[];

  // Derive title field name once
  const titleFieldName =
    fields.find(
      (f) => f.name === "subject" || f.name === "title" || f.name === "name",
    )?.name ?? null;

  // Apply search + filters
  const activeFilterCount = [
    filterDateField !== "" && filterDateValue !== "",
    filterAssignedTo !== "",
    filterOrigin !== "",
    filterSeverities.size > 0,
    filterTag !== "",
  ].filter(Boolean).length;

  // For general users: apply the chip filter from Records page URL param
  const chipFilteredRecords =
    isUserRole && activeFilter !== "all" && activeFilter !== "subtasks"
      ? records // my-tickets already returns only accessible records; chip filter is handled server-side by access reason — keep all for now, chip is visual on Records page only
      : records;

  const filteredRecords = chipFilteredRecords.filter((rec) => {
    if (searchText.trim()) {
      const title = titleFieldName
        ? String(rec.fields[titleFieldName] ?? "")
        : rec.id;
      if (!title.toLowerCase().includes(searchText.toLowerCase())) return false;
    }
    if (filterAssignedTo) {
      if (filterAssignedTo === "__unassigned__") {
        if (rec.assignedTo) return false;
      } else if (rec.assignedTo !== filterAssignedTo) {
        return false;
      }
    }
    if (filterDateField && filterDateValue) {
      const recDate = new Date(rec[filterDateField]);
      const filterDate = new Date(filterDateValue);
      if (
        recDate.getFullYear() !== filterDate.getFullYear() ||
        recDate.getMonth() !== filterDate.getMonth() ||
        recDate.getDate() !== filterDate.getDate()
      )
        return false;
    }
    // Severity/tag/origin (Source) are all applied server-side now — see
    // the fetch effect above — so no client-side filter for them here.
    return true;
  });

  const grouped: Record<string, EntityInstance[]> = {};
  const unassigned: EntityInstance[] = [];
  for (const rec of filteredRecords) {
    if (rec.currentState && states.some((s) => s.name === rec.currentState)) {
      (grouped[rec.currentState] ??= []).push(rec);
    } else {
      unassigned.push(rec);
    }
  }

  // Group child tickets by their parent's current state for sub-tasks sections
  const childByState: Record<string, ChildTicket[]> = {};
  for (const ct of childTickets) {
    if (ct.parentCurrentState) {
      (childByState[ct.parentCurrentState] ??= []).push(ct);
    }
  }

  const columns: Array<{
    state: WorkflowState | null;
    recs: EntityInstance[];
    children: ChildTicket[];
  }> = [
    ...(unassigned.length > 0
      ? [{ state: null, recs: unassigned, children: [] }]
      : []),
    ...orderedStates.map((s) => ({
      state: s,
      recs: grouped[s.name] ?? [],
      children: childByState[s.name] ?? [],
    })),
  ];

  const handleColumnReorder = useCallback(
    (fromName: string, toName: string): void => {
      setColOrder((prev) => {
        const arr = [...prev];
        const fromIdx = arr.indexOf(fromName);
        const toIdx = arr.indexOf(toName);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev;
        arr.splice(fromIdx, 1);
        const newToIdx = arr.indexOf(toName);
        arr.splice(newToIdx, 0, fromName);
        return arr;
      });
    },
    [],
  );

  const executeTransitionDrop = useCallback(
    async (
      recordId: string,
      toStateName: string,
      transition: Transition,
      comment: string,
      fieldUpdates: Record<string, unknown>,
    ): Promise<void> => {
      const rec = records.find((r) => r.id === recordId);
      if (!rec) return;

      setTransitioning(true);
      setTransError(null);

      setRecords((prev) =>
        prev.map((r) =>
          r.id === recordId
            ? {
                ...r,
                currentState: toStateName,
                fields: { ...r.fields, ...fieldUpdates },
              }
            : r,
        ),
      );

      try {
        if (Object.keys(fieldUpdates).length > 0) {
          await fetchWithAuth(`${API_URL}/entities/${recordId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: fieldUpdates }),
          });
        }
        await fetchWithAuth(`${API_URL}/entities/${recordId}/transitions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transitionId: transition.id,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
          }),
        });
      } catch (err) {
        setRecords((prev) =>
          prev.map((r) =>
            r.id === recordId
              ? { ...r, currentState: rec.currentState, fields: rec.fields }
              : r,
          ),
        );
        setTransError(err instanceof Error ? err.message : "Transition failed");
      } finally {
        setTransitioning(false);
      }
    },
    [records],
  );

  const handleCardDrop = useCallback(
    (recordId: string, toStateName: string): void => {
      const rec = records.find((r) => r.id === recordId);
      if (!rec || rec.currentState === toStateName) return;

      const transition = transitions.find(
        (t) => t.fromState === rec.currentState && t.toState === toStateName,
      );
      if (!transition) return;

      const missingFields = transition.requiresFields.filter((name) => {
        const v = rec.fields[name];
        return v === null || v === undefined || v === "";
      });
      const needsModal = transition.requiresComment || missingFields.length > 0;

      if (needsModal) {
        setPendingDrop({ recordId, toStateName, transition });
        return;
      }

      void executeTransitionDrop(recordId, toStateName, transition, "", {});
    },
    [records, transitions, executeTransitionDrop],
  );

  function handleModalConfirm(
    comment: string,
    fieldUpdates: Record<string, unknown>,
  ): void {
    if (!pendingDrop) return;
    const { recordId, toStateName, transition } = pendingDrop;
    setPendingDrop(null);
    void executeTransitionDrop(
      recordId,
      toStateName,
      transition,
      comment,
      fieldUpdates,
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          minHeight: "60vh",
        }}
      >
        <div className="spinner" />
      </div>
    );
  }
  if (error) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          minHeight: "60vh",
        }}
      >
        <div
          className="kb-error"
          style={{
            background: "var(--danger-light)",
            color: "var(--danger)",
            border: "1px solid hsla(350,80%,60%,.25)",
            borderRadius: "var(--radius-sm)",
            padding: "12px 16px",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  const pendingRecord = pendingDrop
    ? records.find((r) => r.id === pendingDrop.recordId)
    : null;
  const pendingToState = pendingDrop
    ? states.find((s) => s.name === pendingDrop.toStateName)
    : null;

  const displayName = entityType?.plural ?? humanizeWorkflowName(workflowName);
  const displayIcon = isRenderableIcon(entityType?.icon)
    ? entityType?.icon
    : null;

  return (
    <div className="kb-page">
      {/* Transition modal */}
      <TransitionModal
        open={pendingDrop !== null && pendingRecord !== null}
        record={pendingRecord ?? { fields: {} }}
        transition={
          pendingDrop?.transition ?? {
            requiresComment: false,
            requiresFields: [],
          }
        }
        toStateLabel={pendingToState?.label ?? pendingDrop?.toStateName ?? ""}
        allFields={fields}
        onConfirm={handleModalConfirm}
        onCancel={() => setPendingDrop(null)}
      />

      {/* Top bar */}
      <div className="kb-topbar">
        <div className="kb-topbar-left">
          <button
            type="button"
            className="kb-back-btn"
            onClick={() => navigate(-1)}
            title="Go back"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 13L5 8l5-5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <h1 className="kb-heading">
            {displayIcon && (
              <span className="kb-heading-icon">{displayIcon}</span>
            )}
            {displayName}
          </h1>
          <span className="kb-record-count">
            {activeFilterCount > 0 && filteredRecords.length !== records.length
              ? `${filteredRecords.length} / ${records.length}`
              : records.length}
          </span>
        </div>

        {/* Right-aligned toolbar */}
        <div className="kb-topbar-right">
          {transitioning && (
            <span className="kb-status-pill kb-status-pill--saving">
              <span className="kb-status-dot" />
              Saving…
            </span>
          )}
          {transError && (
            <span
              className="kb-status-pill kb-status-pill--error"
              onClick={() => setTransError(null)}
              style={{ cursor: "pointer" }}
            >
              ⚠ {transError}
            </span>
          )}

          {/* Collapsible search */}
          <div
            ref={searchWrapRef}
            className={`kb-search-wrap ${searchExpanded ? "kb-search-wrap-open" : ""}`}
          >
            <button
              type="button"
              className="kb-search-icon-btn"
              onClick={() => {
                setSearchExpanded(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
              title="Search"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
            {searchExpanded && (
              <>
                <input
                  ref={searchInputRef}
                  className="kb-search"
                  placeholder="Search by title…"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                />
                {searchText && (
                  <button
                    type="button"
                    className="kb-search-clear"
                    onClick={() => setSearchText("")}
                  >
                    ×
                  </button>
                )}
              </>
            )}
          </div>

          {/* Filter */}
          <div style={{ position: "relative" }}>
            <button
              ref={filterBtnRef}
              type="button"
              className={`kb-circ-btn ${filterOpen ? "kb-circ-btn-open" : ""} ${activeFilterCount > 0 ? "kb-circ-btn-active" : ""}`}
              onClick={() => setFilterOpen((v) => !v)}
              title="Filters"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              {activeFilterCount > 0 && (
                <span className="kb-circ-badge">{activeFilterCount}</span>
              )}
            </button>

            {filterOpen && (
              <div ref={filterPanelRef} className="kb-filter-panel">
                <div className="kb-filter-panel-header">
                  <span className="kb-filter-panel-title">Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      type="button"
                      className="kb-filter-clear-all"
                      onClick={() => {
                        setFilterDateField("");
                        setFilterDateValue("");
                        setFilterAssignedTo("");
                        setFilterOrigin("");
                        setFilterSeverities(new Set());
                        setFilterTagInput("");
                        setFilterTag("");
                        setUserSearch("");
                      }}
                    >
                      Clear all
                    </button>
                  )}
                </div>

                {/* Date filter */}
                <div className="kb-filter-section">
                  <div className="kb-filter-section-label">Date</div>
                  <select
                    className="kb-filter-select"
                    value={filterDateField}
                    onChange={(e) => {
                      setFilterDateField(
                        e.target.value as "createdAt" | "updatedAt" | "",
                      );
                      setFilterDateValue("");
                    }}
                  >
                    <option value="">Select field…</option>
                    <option value="createdAt">Created at</option>
                    <option value="updatedAt">Last updated</option>
                  </select>
                  {filterDateField && (
                    <input
                      type="date"
                      className="kb-filter-date-input"
                      value={filterDateValue}
                      onChange={(e) => setFilterDateValue(e.target.value)}
                      style={{ marginTop: "8px" }}
                    />
                  )}
                </div>

                {/* Source filter — docs/specs/third-party-api-origin-tagging.md */}
                <div className="kb-filter-section">
                  <div className="kb-filter-section-label">Source</div>
                  <div className="kb-filter-origin-options">
                    {[
                      { key: "" as const, label: "Any", color: null },
                      {
                        key: "internal" as const,
                        label: "Internal",
                        color: null,
                      },
                      {
                        key: "external" as const,
                        label: LABEL_BY_MECHANISM.api,
                        color: COLOR_BY_MECHANISM.api,
                      },
                      {
                        key: "redirected" as const,
                        label: LABEL_BY_MECHANISM.handoff,
                        color: COLOR_BY_MECHANISM.handoff,
                      },
                    ].map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={`kb-filter-origin-chip ${filterOrigin === opt.key ? "kb-filter-origin-chip-active" : ""}`}
                        onClick={() => setFilterOrigin(opt.key)}
                        style={
                          opt.color && filterOrigin === opt.key
                            ? {
                                background: opt.color,
                                borderColor: opt.color,
                                color: "hsl(0, 0%, 100%)",
                              }
                            : undefined
                        }
                      >
                        {opt.color && (
                          <span
                            className="kb-filter-origin-dot"
                            style={{
                              background:
                                filterOrigin === opt.key
                                  ? "hsl(0, 0%, 100%)"
                                  : opt.color,
                            }}
                          />
                        )}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Severity filter — docs/specs/ticket-severity-and-tags.md R6 */}
                <div className="kb-filter-section">
                  <div className="kb-filter-section-label">Severity</div>
                  <div className="kb-filter-origin-options">
                    {SEVERITY_LEVELS.map((level) => {
                      const active = filterSeverities.has(level);
                      const color = SEVERITY_COLOR[level];
                      return (
                        <button
                          key={level}
                          type="button"
                          className={`kb-filter-origin-chip ${active ? "kb-filter-origin-chip-active" : ""}`}
                          onClick={() =>
                            setFilterSeverities((prev) => {
                              const next = new Set(prev);
                              if (next.has(level)) next.delete(level);
                              else next.add(level);
                              return next;
                            })
                          }
                          style={
                            active
                              ? {
                                  background: color,
                                  borderColor: color,
                                  color: "hsl(0, 0%, 100%)",
                                }
                              : undefined
                          }
                        >
                          <span
                            className="kb-filter-origin-dot"
                            style={{
                              background: active ? "hsl(0, 0%, 100%)" : color,
                            }}
                          />
                          {SEVERITY_LABEL[level]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Tag filter — docs/specs/ticket-severity-and-tags.md R6 */}
                <div className="kb-filter-section">
                  <div className="kb-filter-section-label">Tag</div>
                  <input
                    type="text"
                    className="kb-filter-select"
                    placeholder="Filter by exact tag…"
                    value={filterTagInput}
                    onChange={(e) => handleFilterTagInputChange(e.target.value)}
                  />
                </div>

                {/* Assigned to filter */}
                <div className="kb-filter-section">
                  <div className="kb-filter-section-label">Assigned to</div>
                  <div className="kb-filter-user-search-wrap">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      className="kb-filter-user-search"
                      placeholder="Search name or email…"
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                    />
                  </div>
                  <div className="kb-filter-assignee-list">
                    {!userSearch && (
                      <>
                        <button
                          type="button"
                          className={`kb-filter-assignee-item ${filterAssignedTo === "" ? "kb-filter-assignee-active" : ""}`}
                          onClick={() => setFilterAssignedTo("")}
                        >
                          <span className="kb-filter-assignee-avatar kb-filter-assignee-avatar-all">
                            A
                          </span>
                          <span>Anyone</span>
                          {filterAssignedTo === "" && (
                            <svg
                              className="kb-filter-check"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`kb-filter-assignee-item ${filterAssignedTo === "__unassigned__" ? "kb-filter-assignee-active" : ""}`}
                          onClick={() =>
                            setFilterAssignedTo(
                              filterAssignedTo === "__unassigned__"
                                ? ""
                                : "__unassigned__",
                            )
                          }
                        >
                          <span className="kb-filter-assignee-avatar kb-filter-assignee-avatar-none">
                            ?
                          </span>
                          <span>Unassigned</span>
                          {filterAssignedTo === "__unassigned__" && (
                            <svg
                              className="kb-filter-check"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      </>
                    )}
                    {users
                      .filter((u) => {
                        if (!userSearch) return true;
                        const q = userSearch.toLowerCase();
                        return (
                          (u.displayName ?? "").toLowerCase().includes(q) ||
                          u.email.toLowerCase().includes(q)
                        );
                      })
                      .map((u) => (
                        <button
                          key={u.userId}
                          type="button"
                          className={`kb-filter-assignee-item ${filterAssignedTo === u.userId ? "kb-filter-assignee-active" : ""}`}
                          onClick={() =>
                            setFilterAssignedTo(
                              filterAssignedTo === u.userId ? "" : u.userId,
                            )
                          }
                        >
                          <span className="kb-filter-assignee-avatar">
                            {(u.displayName ?? u.email)
                              .slice(0, 1)
                              .toUpperCase()}
                          </span>
                          <span className="kb-filter-assignee-name">
                            {u.displayName ?? u.email}
                          </span>
                          {filterAssignedTo === u.userId && (
                            <svg
                              className="kb-filter-check"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          )}
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Settings */}
          {showSettings && workflowSlug && (
            <Link
              to={`/workflows/${workflowSlug}`}
              className="kb-circ-btn"
              title="Workflow Settings"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </Link>
          )}

          {/* New record */}
          {entityTypeId && (
            <Link
              to={`/records/${typeSlug || entityTypeId}/new`}
              state={{
                workflowId,
                entityTypeId,
                returnTo: `/workflows/${workflowSlug ?? ""}/records`,
              }}
              className="kb-circ-btn kb-circ-btn-primary"
              title={`New ${entityType?.name ?? "Record"}`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </Link>
          )}
        </div>
      </div>

      <div className="kb-divider" />

      {/* Board */}
      {records.length === 0 && states.length === 0 ? (
        <div className="kb-empty-state">
          <div className="kb-empty-icon">📋</div>
          <p className="kb-empty-title">No {displayName.toLowerCase()} yet</p>
          {(typeSlug || entityTypeId) && (
            <Link
              to={`/records/${typeSlug || entityTypeId}/new`}
              state={{
                workflowId,
                entityTypeId,
                returnTo: `/workflows/${workflowSlug ?? ""}/records`,
              }}
              className="kb-new-btn"
            >
              Create the first one
            </Link>
          )}
        </div>
      ) : (
        <div className="kb-board-scroll">
          <div className="kb-board">
            {columns.map(({ state, recs, children }) => (
              <KanbanColumn
                key={state?.name ?? "__unassigned__"}
                state={state}
                records={recs}
                fields={fields}
                typeSlug={typeSlug}
                entityTypeId={entityTypeId}
                workflowId={workflowId}
                transitions={transitions}
                allRecords={records}
                onCardDrop={(recordId, toStateName) =>
                  handleCardDrop(recordId, toStateName)
                }
                onColumnDrop={handleColumnReorder}
                childTickets={children}
                users={users}
              />
            ))}
          </div>
        </div>
      )}

      <style>{`
        .kb-page {
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 0;
          overflow: hidden;
          background: var(--bg-primary);
          color: var(--text-primary);
          font-family: var(--font-sans);
        }

        .kb-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 28px 16px;
          flex-shrink: 0;
          gap: 12px;
        }
        .kb-topbar-left  { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .kb-topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

        .kb-heading {
          font-size: 18px; font-weight: 600;
          font-family: var(--font-heading);
          color: var(--text-primary); margin: 0;
          display: flex; align-items: center; gap: 8px;
        }
        .kb-heading-icon { font-size: 20px; }

        .kb-record-count {
          font-size: 12px; font-weight: 500;
          color: var(--text-muted); background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          border-radius: 20px; padding: 2px 8px;
        }

        .kb-divider {
          height: 1px; background: var(--border-color);
          flex-shrink: 0; margin: 0 28px;
        }

        .kb-status-pill {
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; padding: 4px 10px;
          border-radius: 20px; font-weight: 500;
        }
        .kb-status-pill--saving {
          background: hsla(var(--accent-h,250),var(--accent-s,84%),var(--accent-l,60%),.12);
          color: var(--accent-primary);
          border: 1px solid hsla(var(--accent-h,250),var(--accent-s,84%),var(--accent-l,60%),.25);
        }
        .kb-status-pill--error {
          background: var(--danger-light); color: var(--danger);
          border: 1px solid hsla(350,80%,60%,.25);
        }
        .kb-status-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: currentColor;
          animation: kb-pulse 1.4s ease-in-out infinite;
        }
        @keyframes kb-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }

        /* ── Circular icon buttons ── */
        .kb-circ-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; padding: 0; flex-shrink: 0;
          border-radius: 50%;
          background: var(--bg-secondary); border: 1px solid var(--border-color);
          color: var(--text-secondary); cursor: pointer; text-decoration: none;
          transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
          position: relative;
        }
        .kb-circ-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
        .kb-circ-btn-open { border-color: var(--accent-primary); color: var(--accent-primary); background: hsla(250,84%,60%,.08); }
        .kb-circ-btn-active { border-color: var(--accent-primary); color: var(--accent-primary); }
        .kb-circ-btn-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }
        .kb-circ-btn-primary:hover { opacity: .88; background: var(--accent-primary); color: #fff; }
        .kb-circ-badge {
          position: absolute; top: -3px; right: -3px;
          width: 14px; height: 14px; border-radius: 50%;
          background: var(--accent-primary); color: #fff;
          font-size: 8px; font-weight: 700; line-height: 1;
          display: flex; align-items: center; justify-content: center;
          border: 1.5px solid var(--bg-primary);
        }
        .kb-back-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 32px; height: 32px; padding: 0;
          border-radius: var(--radius-sm);
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          color: var(--text-secondary);
          cursor: pointer;
          transition: background var(--transition-fast), color var(--transition-fast);
          flex-shrink: 0;
        }
        .kb-back-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }

        .kb-new-btn {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 500; padding: 7px 14px;
          border-radius: var(--radius-sm);
          background: var(--accent-primary); color: #fff;
          text-decoration: none;
          transition: opacity var(--transition-fast), transform var(--transition-fast);
          white-space: nowrap;
        }
        .kb-new-btn:hover { opacity: .88; transform: translateY(-1px); }

        .kb-board-scroll {
          flex: 1; overflow-x: auto; overflow-y: hidden;
          padding: 20px 28px 24px;
        }
        .kb-board {
          display: flex; gap: 12px; align-items: flex-start;
          min-height: calc(100vh - 185px);
          width: max-content;
        }

        .kb-col {
          width: 272px;
          display: flex; flex-direction: column;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
          min-height: 50vh;
          max-height: calc(100vh - 185px);
        }
        .kb-col--valid {
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px hsla(var(--accent-h,250),var(--accent-s,84%),var(--accent-l,60%),.18);
        }
        .kb-col--blocked {
          border-color: var(--danger);
          box-shadow: 0 0 0 2px hsla(350,80%,60%,.14);
        }
        .kb-col--reorder {
          border-color: hsl(200,84%,55%);
          box-shadow: -4px 0 0 0 hsl(200,84%,55%);
        }

        .kb-col-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 10px 12px 10px 10px; flex-shrink: 0;
          border-bottom: 1px solid var(--border-subtle);
          cursor: grab;
          user-select: none;
        }
        .kb-col-header:active { cursor: grabbing; }
        .kb-col-header-left { display: flex; align-items: center; gap: 6px; }
        .kb-col-drag-handle {
          color: var(--text-muted); opacity: .5; flex-shrink: 0;
          display: flex; align-items: center;
        }
        .kb-col-header:hover .kb-col-drag-handle { opacity: 1; }
        .kb-col-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; pointer-events: none; }
        .kb-col-title {
          font-size: 12px; font-weight: 600;
          letter-spacing: .05em; text-transform: uppercase;
          color: var(--text-secondary); pointer-events: none;
        }
        .kb-col-count {
          font-size: 11px; font-weight: 600;
          color: var(--text-muted); background: var(--bg-tertiary);
          border: 1px solid var(--border-subtle);
          border-radius: 20px; padding: 1px 7px;
          min-width: 20px; text-align: center;
          pointer-events: none;
        }

        .kb-col-body {
          flex: 1; overflow-y: auto;
          padding: 10px 10px 4px;
          display: flex; flex-direction: column; gap: 7px;
          scrollbar-width: thin;
          scrollbar-color: var(--border-color) transparent;
        }
        .kb-col-empty {
          font-size: 12px; color: var(--text-muted);
          text-align: center; padding: 28px 0; opacity: .6;
        }

        .kb-drop-zone {
          display: flex; align-items: center; justify-content: center;
          border: 2px dashed var(--accent-primary);
          border-radius: var(--radius-sm); padding: 14px;
          font-size: 12px; font-weight: 500; color: var(--accent-primary);
          background: hsla(var(--accent-h,250),var(--accent-s,84%),var(--accent-l,60%),.06);
          animation: kb-fadein .12s ease;
        }
        .kb-reorder-zone {
          display: flex; align-items: center; justify-content: center;
          border: 2px dashed hsl(200,84%,55%);
          border-radius: var(--radius-sm); padding: 14px;
          font-size: 12px; font-weight: 500; color: hsl(200,84%,55%);
          background: hsla(200,84%,55%,.06);
          animation: kb-fadein .12s ease;
        }
        @keyframes kb-fadein { from{opacity:0;transform:scaleY(.9)} to{opacity:1;transform:scaleY(1)} }

        .kb-subtasks {
          margin-top: 10px;
          padding: 8px 8px 10px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-subtle);
          border-radius: 10px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .kb-subtasks-divider {
          display: flex; align-items: center; gap: 6px;
          padding: 0 2px;
        }
        .kb-subtasks-label {
          font-size: 10px; font-weight: 700; letter-spacing: .06em;
          color: var(--text-muted); text-transform: uppercase; white-space: nowrap;
          display: flex; align-items: center; gap: 5px;
        }
        .kb-subtasks-label::before {
          content: '';
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--accent-primary); opacity: .6;
        }
        .kb-card--child {
          cursor: pointer;
          background: var(--bg-secondary);
          border-left: 3px solid var(--accent-primary);
        }
        .kb-child-status-badge {
          font-size: 10px; font-weight: 500;
          padding: 1px 6px; border-radius: 10px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-color);
          color: var(--text-muted);
          white-space: nowrap;
        }
        .kb-child-status-badge--done {
          background: hsla(142,72%,40%,.12);
          border-color: hsla(142,72%,40%,.3);
          color: hsl(142,60%,40%);
        }
        .kb-subtask-avatar {
          width: 18px; height: 18px; border-radius: 50%;
          background: var(--accent-primary); color: #fff;
          font-size: 10px; font-weight: 600;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }

        .kb-col-footer {
          padding: 6px 10px 8px;
          border-top: 1px solid var(--border-subtle); flex-shrink: 0;
        }
        .kb-add-btn {
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 500; color: var(--text-muted);
          padding: 6px 8px; border-radius: var(--radius-sm);
          background: none; border: none; cursor: pointer; width: 100%;
          transition: color var(--transition-fast), background var(--transition-fast);
        }
        .kb-add-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

        .kb-card {
          position: relative;
          background: var(--bg-card);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-sm);
          padding: 11px 12px;
          cursor: grab;
          user-select: none;
          -webkit-user-drag: element;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
          transition:
            box-shadow var(--transition-fast),
            transform var(--transition-fast),
            opacity var(--transition-fast),
            border-color var(--transition-fast);
        }
        .kb-card-origin-corner {
          position: absolute;
          top: 8px;
          right: 8px;
          display: inline-flex;
          align-items: center;
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 9.5px;
          font-weight: 700;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          line-height: 1.4;
          white-space: nowrap;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
          z-index: 1;
        }
        .kb-card:hover {
          box-shadow: var(--shadow-sm);
          border-color: var(--border-focus);
          transform: translateY(-1px);
        }
        .kb-card:active { cursor: grabbing; }
        .kb-card--ghost { opacity: .35; }

        .kb-card-title {
          font-size: 13px; font-weight: 500;
          color: var(--text-primary); margin-bottom: 6px;
          line-height: 1.4; overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          pointer-events: none;
        }
        .kb-card-meta {
          display: flex; align-items: baseline; gap: 5px; margin-bottom: 4px;
          pointer-events: none;
        }
        .kb-card-meta-label {
          font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
          color: var(--text-muted); flex-shrink: 0;
        }
        .kb-card-meta-value {
          font-size: 12px; color: var(--text-secondary);
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
        }
        .kb-card-footer {
          display: flex; align-items: center; justify-content: space-between;
          margin-top: 8px; padding-top: 7px;
          border-top: 1px solid var(--border-subtle);
          pointer-events: none;
        }
        .kb-card-id   { font-size:10px; font-family:monospace; color:var(--text-muted); opacity:.7; }
        .kb-card-time { font-size:10px; color:var(--text-muted); opacity:.7; }
        .kb-card-assignee {
          display: flex; align-items: center; gap: 5px;
          font-size: 10px; color: var(--text-muted); opacity: .8;
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 120px;
        }
        .kb-card-avatar {
          width: 16px; height: 16px; border-radius: 50%; flex-shrink: 0;
          background: var(--accent-primary); color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-size: 9px; font-weight: 600;
        }

        .kb-empty-state {
          flex: 1; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          gap: 12px; padding: 60px 24px;
        }
        .kb-empty-icon  { font-size: 40px; opacity: .4; }
        .kb-empty-title { font-size: 15px; color: var(--text-secondary); margin: 0; }
        .kb-error {
          background: var(--danger-light); color: var(--danger);
          border: 1px solid hsla(350,80%,60%,.25);
          border-radius: var(--radius-sm); padding: 12px 16px;
          font-size: 13px; margin: 24px 28px;
        }
        .kb-loading { display: flex; justify-content: center; padding: 60px; }

        /* ── Collapsible search ── */
        .kb-search-wrap {
          display: flex; align-items: center; gap: 0;
          background: var(--bg-secondary); border: 1px solid var(--border-color);
          border-radius: 34px; overflow: hidden;
          width: 34px; height: 34px;
          transition: width .22s cubic-bezier(.4,0,.2,1), border-color .15s, box-shadow .15s;
        }
        .kb-search-wrap-open {
          width: 200px;
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px hsla(250,84%,60%,.14);
        }
        .kb-search-icon-btn {
          display: flex; align-items: center; justify-content: center;
          width: 34px; height: 34px; min-width: 34px; padding: 0;
          background: none; border: none; cursor: pointer;
          color: var(--text-secondary);
          transition: color var(--transition-fast);
        }
        .kb-search-wrap-open .kb-search-icon-btn { color: var(--accent-primary); }
        .kb-search {
          flex: 1; background: none; border: none; outline: none;
          font-size: 13px; color: var(--text-primary); min-width: 0;
          padding: 0;
        }
        .kb-search::placeholder { color: var(--text-muted); }
        .kb-search-clear {
          background: none; border: none; cursor: pointer;
          color: var(--text-muted); font-size: 15px; line-height: 1;
          padding: 0 8px 0 2px; display: flex; align-items: center;
          transition: color var(--transition-fast);
        }
        .kb-search-clear:hover { color: var(--text-primary); }


        .kb-filter-panel {
          position: absolute; top: calc(100% + 6px); right: 0; z-index: 300;
          width: 280px; background: var(--bg-secondary);
          border: 1px solid var(--border-color); border-radius: var(--radius-md);
          box-shadow: 0 8px 32px rgba(0,0,0,.45);
          animation: kb-fadein .1s ease;
        }
        .kb-filter-panel-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px 8px;
          border-bottom: 1px solid var(--border-color);
        }
        .kb-filter-panel-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .05em; }
        .kb-filter-clear-all {
          background: none; border: none; cursor: pointer;
          font-size: 12px; color: var(--accent-primary); font-weight: 500;
          padding: 0; transition: opacity var(--transition-fast);
        }
        .kb-filter-clear-all:hover { opacity: .7; }

        .kb-filter-section { padding: 12px 14px; border-bottom: 1px solid var(--border-color); }
        .kb-filter-section:last-child { border-bottom: none; padding-bottom: 8px; }
        .kb-filter-section-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }

        .kb-filter-select {
          width: 100%; padding: 6px 9px;
          background: var(--bg-tertiary); border: 1px solid var(--border-color);
          border-radius: var(--radius-sm); color: var(--text-primary);
          font-size: 12.5px; cursor: pointer; outline: none;
          transition: border-color var(--transition-fast);
        }
        .kb-filter-select:focus { border-color: var(--accent-primary); }
        .kb-filter-date-input {
          width: 100%; padding: 6px 9px; box-sizing: border-box;
          background: var(--bg-tertiary); border: 1px solid var(--border-color);
          border-radius: var(--radius-sm); color: var(--text-primary);
          font-size: 12.5px; outline: none;
          transition: border-color var(--transition-fast);
        }
        .kb-filter-date-input:focus { border-color: var(--accent-primary); }

        .kb-filter-origin-options { display: flex; flex-wrap: wrap; gap: 6px; }
        .kb-filter-origin-chip {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 4px 10px; border-radius: 999px;
          background: var(--bg-tertiary); border: 1px solid var(--border-color);
          color: var(--text-secondary); font-size: 12px; font-weight: 600;
          cursor: pointer; transition: background var(--transition-fast), border-color var(--transition-fast);
        }
        .kb-filter-origin-chip:hover { border-color: var(--border-focus); }
        .kb-filter-origin-chip-active { background: hsla(250,84%,60%,.12); border-color: hsla(250,84%,60%,.4); color: var(--accent-primary); }
        .kb-filter-origin-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

        .kb-filter-user-search-wrap {
          display: flex; align-items: center; gap: 7px;
          background: var(--bg-tertiary); border: 1px solid var(--border-color);
          border-radius: var(--radius-sm); padding: 6px 9px; margin-bottom: 6px;
          transition: border-color var(--transition-fast);
        }
        .kb-filter-user-search-wrap:focus-within { border-color: var(--accent-primary); }
        .kb-filter-user-search-wrap svg { color: var(--text-muted); flex-shrink: 0; }
        .kb-filter-user-search {
          flex: 1; background: none; border: none; outline: none;
          font-size: 12.5px; color: var(--text-primary);
        }
        .kb-filter-user-search::placeholder { color: var(--text-muted); }

        .kb-filter-assignee-list { display: flex; flex-direction: column; gap: 1px; max-height: 180px; overflow-y: auto; }
        .kb-filter-assignee-item {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px; border-radius: var(--radius-sm);
          background: none; border: none; cursor: pointer;
          font-size: 13px; color: var(--text-primary); text-align: left;
          transition: background var(--transition-fast);
          width: 100%;
        }
        .kb-filter-assignee-item:hover { background: hsla(250,84%,60%,.07); }
        .kb-filter-assignee-active { background: hsla(250,84%,60%,.12); color: var(--accent-primary); }
        .kb-filter-assignee-avatar {
          width: 24px; height: 24px; border-radius: 50%;
          background: hsla(250,84%,60%,.2); color: var(--accent-primary);
          font-size: 11px; font-weight: 700;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .kb-filter-assignee-avatar-all { background: var(--bg-tertiary); color: var(--text-muted); }
        .kb-filter-assignee-avatar-none { background: var(--bg-tertiary); color: var(--text-muted); font-style: italic; }
        .kb-filter-assignee-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .kb-filter-check { flex-shrink: 0; color: var(--accent-primary); margin-left: auto; }

        .tm-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0,0,0,.45);
          display: flex; align-items: center; justify-content: center;
          padding: 24px;
          animation: kb-fadein .1s ease;
        }
        .tm-modal {
          background: var(--bg-card);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-lg, 0 20px 60px rgba(0,0,0,.3));
          width: 100%; max-width: 440px;
          display: flex; flex-direction: column;
          overflow: hidden;
        }
        .tm-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 16px 20px; border-bottom: 1px solid var(--border-subtle);
          flex-shrink: 0;
        }
        .tm-header-left { display: flex; align-items: center; gap: 10px; }
        .tm-icon { font-size: 16px; color: var(--accent-primary); }
        .tm-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
        .tm-close {
          background: none; border: none; cursor: pointer;
          color: var(--text-muted); padding: 4px;
          border-radius: var(--radius-sm);
          display: flex; align-items: center; justify-content: center;
          transition: color var(--transition-fast), background var(--transition-fast);
        }
        .tm-close:hover { color: var(--text-primary); background: var(--bg-tertiary); }

        .tm-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }

        .tm-field { display: flex; flex-direction: column; gap: 6px; }
        .tm-label {
          font-size: 12px; font-weight: 500; color: var(--text-secondary);
          display: flex; align-items: center; gap: 3px;
        }
        .tm-required { color: var(--danger); font-size: 13px; line-height: 1; }
        .tm-input {
          width: 100%; padding: 8px 10px;
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-sm);
          color: var(--text-primary); font-size: 13px;
          font-family: var(--font-sans);
          transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
          box-sizing: border-box;
          outline: none;
        }
        .tm-input:focus {
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px hsla(var(--accent-h,250),var(--accent-s,84%),var(--accent-l,60%),.18);
        }
        .tm-textarea { resize: vertical; min-height: 80px; }
        select.tm-input { cursor: pointer; }

        .tm-footer {
          display: flex; align-items: center; justify-content: flex-end; gap: 8px;
          padding: 14px 20px; border-top: 1px solid var(--border-subtle); flex-shrink: 0;
        }
        .tm-btn-cancel {
          background: none; border: 1px solid var(--border-color);
          color: var(--text-secondary); font-size: 13px; font-weight: 500;
          padding: 7px 16px; border-radius: var(--radius-sm); cursor: pointer;
          transition: background var(--transition-fast), color var(--transition-fast);
        }
        .tm-btn-cancel:hover { background: var(--bg-tertiary); color: var(--text-primary); }
        .tm-btn-confirm {
          background: var(--accent-primary); color: #fff;
          border: none; font-size: 13px; font-weight: 500;
          padding: 7px 18px; border-radius: var(--radius-sm); cursor: pointer;
          transition: opacity var(--transition-fast);
        }
        .tm-btn-confirm:hover:not(:disabled) { opacity: .88; }
        .tm-btn-confirm:disabled { opacity: .45; cursor: not-allowed; }

        /* ── Mobile responsiveness ──────────────────────────────────────
           Topbar-left (back + heading + count) and topbar-right (search,
           filter, settings, new) both had flex-shrink:0 with no wrap —
           their combined minimum width already exceeds a 375px viewport
           even with the search collapsed, let alone expanded. Wrap the
           topbar to two rows on mobile instead of letting it overflow. */
        @media (max-width: 640px) {
          .kb-topbar {
            flex-wrap: wrap;
            padding: 16px 16px 12px;
          }
          .kb-topbar-left {
            flex-shrink: 1;
            min-width: 0;
          }
          .kb-heading {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .kb-topbar-right {
            width: 100%;
            justify-content: flex-end;
            flex-wrap: wrap;
          }
          .kb-divider { margin: 0 16px; }
          .kb-board-scroll { padding: 16px 16px 20px; }
          .kb-error { margin: 20px 16px; }
        }

        @media (max-width: 480px) {
          .kb-topbar { padding: 14px 14px 10px; }
          .kb-search-wrap-open { width: 150px; }
          .kb-board-scroll { padding: 14px 14px 18px; }
          .kb-col { width: 240px; }
          .kb-filter-panel { max-width: calc(100vw - 24px); }
        }
      `}</style>
    </div>
  );
}
