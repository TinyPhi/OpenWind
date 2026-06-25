import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes, toTypeSlug } from "../../entity-type-context.js";
import { userManager } from "../../authProvider.js";

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

// ── Transition Modal ───────────────────────────────────────────────────────────

function TransitionModal({
  record,
  transition,
  toStateLabel,
  allFields,
  onConfirm,
  onCancel,
}: {
  record: EntityInstance;
  transition: Transition;
  toStateLabel: string;
  allFields: EntityField[];
  onConfirm: (comment: string, fieldUpdates: Record<string, unknown>) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [comment, setComment] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const name of transition.requiresFields) {
      const existing = record.fields[name];
      init[name] =
        existing !== null && existing !== undefined ? String(existing) : "";
    }
    return init;
  });

  const requiredFields = transition.requiresFields
    .map((name) => allFields.find((f) => f.name === name))
    .filter(Boolean) as EntityField[];

  const isValid =
    (!transition.requiresComment || comment.trim().length > 0) &&
    transition.requiresFields.every(
      (name) => (fieldValues[name] ?? "").trim().length > 0,
    );

  function handleFieldChange(name: string, value: string): void {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(): void {
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fieldValues)) {
      if (v.trim()) updates[k] = v.trim();
    }
    onConfirm(comment, updates);
  }

  return (
    <div className="tm-overlay" onClick={onCancel}>
      <div className="tm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tm-header">
          <div className="tm-header-left">
            <span className="tm-icon">→</span>
            <span className="tm-title">Move to {toStateLabel}</span>
          </div>
          <button className="tm-close" onClick={onCancel}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M1 1l12 12M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="tm-body">
          {requiredFields.map((f) => (
            <div key={f.id} className="tm-field">
              <label className="tm-label">
                {f.label}
                <span className="tm-required">*</span>
              </label>
              {f.fieldType === "enum" ? (
                <select
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                >
                  <option value="">Select…</option>
                  {(f.config.options ?? []).map((opt) => {
                    const val = typeof opt === "string" ? opt : opt.value;
                    const lbl = typeof opt === "string" ? opt : opt.label;
                    return (
                      <option key={val} value={val}>
                        {lbl}
                      </option>
                    );
                  })}
                </select>
              ) : f.fieldType === "long_text" ? (
                <textarea
                  className="tm-input tm-textarea"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                  rows={3}
                  placeholder={`Enter ${f.label.toLowerCase()}…`}
                />
              ) : f.fieldType === "number" || f.fieldType === "currency" ? (
                <input
                  type="number"
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                  placeholder={`Enter ${f.label.toLowerCase()}…`}
                />
              ) : f.fieldType === "date" || f.fieldType === "datetime" ? (
                <input
                  type={f.fieldType === "datetime" ? "datetime-local" : "date"}
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                />
              ) : (
                <input
                  type="text"
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                  placeholder={`Enter ${f.label.toLowerCase()}…`}
                />
              )}
            </div>
          ))}

          {transition.requiresComment && (
            <div className="tm-field">
              <label className="tm-label">
                Comment
                <span className="tm-required">*</span>
              </label>
              <textarea
                className="tm-input tm-textarea"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder="Add a comment for this transition…"
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="tm-footer">
          <button className="tm-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tm-btn-confirm"
            onClick={handleSubmit}
            disabled={!isValid}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────────

function RecordCard({
  record,
  fields,
  typeSlug,
}: {
  record: EntityInstance;
  fields: EntityField[];
  typeSlug: string;
}): React.ReactElement {
  const navigate = useNavigate();
  const divRef = useRef<HTMLDivElement>(null);

  const preview: Array<{ field: EntityField; value: string }> = [];
  for (const f of fields) {
    if (preview.length >= 2) break;
    const v = fieldDisplay(record.fields[f.name], f.fieldType);
    if (v) preview.push({ field: f, value: v });
  }

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
      <div className="kb-card-title">
        {preview[0]?.value ?? `#${record.id.slice(0, 8)}`}
      </div>

      {preview[1] && (
        <div className="kb-card-meta">
          <span className="kb-card-meta-label">{preview[1].field.label}</span>
          <span className="kb-card-meta-value">{preview[1].value}</span>
        </div>
      )}

      <div className="kb-card-footer">
        <span className="kb-card-id">#{record.id.slice(0, 8)}</span>
        <span className="kb-card-time">{relativeTime(record.createdAt)}</span>
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
          />
        ))}

        {records.length === 0 && dropState === "idle" && (
          <div className="kb-col-empty">No items</div>
        )}

        {dropState === "valid" && (
          <div className="kb-drop-zone">Drop to move here</div>
        )}

        {dropState === "reorder" && (
          <div className="kb-reorder-zone">Insert column here</div>
        )}
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function WorkflowRecords(): React.ReactElement {
  const { workflowSlug } = useParams<{ workflowSlug: string }>();
  const navigate = useNavigate();
  const { getTypeById } = useEntityTypes();

  const [workflowId, setWorkflowId] = useState<string>("");
  const [entityTypeId, setEntityTypeId] = useState<string>("");
  const [workflowName, setWorkflowName] = useState<string>("");
  const [workflowAssignedTo, setWorkflowAssignedTo] = useState<string | null>(
    null,
  );
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRoles, setCurrentUserRoles] = useState<string[]>([]);
  const [fields, setFields] = useState<EntityField[]>([]);
  const [records, setRecords] = useState<EntityInstance[]>([]);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transError, setTransError] = useState<string | null>(null);

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
      setCurrentUserRoles(roleClaim ? Object.keys(roleClaim) : []);
    });
  }, []);

  useEffect(() => {
    if (!workflowSlug) return;
    setLoading(true);
    setError(null);

    // Fetch all workflows, find the one whose slugified name matches
    fetchWithAuth(`${API_URL}/workflows`)
      .then(async (listRes) => {
        const all =
          (
            listRes as {
              data?: Array<{
                id: string;
                name: string;
                entityTypeId: string;
                states: WorkflowState[];
                transitions: Transition[];
              }>;
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
              assignedTo: string | null;
              states: WorkflowState[];
              transitions: Transition[];
            };
          }
        ).data;

        setWorkflowId(wf.id);
        setWorkflowName(wf.name);
        setEntityTypeId(wf.entityTypeId);
        setWorkflowAssignedTo(wf.assignedTo ?? null);

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

        const [fieldsRes, recRes] = await Promise.all([
          fetchWithAuth(`${API_URL}/entity-types/${wf.entityTypeId}/fields`),
          fetchWithAuth(`${API_URL}/entities?entityTypeId=${wf.entityTypeId}`),
        ]);
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        setRecords((recRes as { data?: EntityInstance[] }).data ?? []);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [workflowSlug]);

  const entityType = entityTypeId ? getTypeById(entityTypeId) : undefined;
  const typeSlug = entityType
    ? toTypeSlug(entityType.plural || entityType.name)
    : "";

  const showSettings =
    currentUserId !== null &&
    (currentUserRoles.includes("admin") ||
      (workflowAssignedTo !== null && currentUserId === workflowAssignedTo));

  const orderedStates: WorkflowState[] = colOrder
    .map((name) => states.find((s) => s.name === name))
    .filter(Boolean) as WorkflowState[];

  const grouped: Record<string, EntityInstance[]> = {};
  const unassigned: EntityInstance[] = [];
  for (const rec of records) {
    if (rec.currentState && states.some((s) => s.name === rec.currentState)) {
      (grouped[rec.currentState] ??= []).push(rec);
    } else {
      unassigned.push(rec);
    }
  }

  const columns: Array<{
    state: WorkflowState | null;
    recs: EntityInstance[];
  }> = [
    ...(unassigned.length > 0 ? [{ state: null, recs: unassigned }] : []),
    ...orderedStates.map((s) => ({ state: s, recs: grouped[s.name] ?? [] })),
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
      <div className="kb-page">
        <div className="kb-loading">
          <div className="spinner" />
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-page">
        <div className="kb-error">{error}</div>
      </div>
    );
  }

  const pendingRecord = pendingDrop
    ? records.find((r) => r.id === pendingDrop.recordId)
    : null;
  const pendingToState = pendingDrop
    ? states.find((s) => s.name === pendingDrop.toStateName)
    : null;

  const displayName = entityType?.plural ?? workflowName;
  const displayIcon = entityType?.icon ?? null;

  return (
    <div className="kb-page">
      {/* Transition modal */}
      {pendingDrop && pendingRecord && (
        <TransitionModal
          record={pendingRecord}
          transition={pendingDrop.transition}
          toStateLabel={pendingToState?.label ?? pendingDrop.toStateName}
          allFields={fields}
          onConfirm={handleModalConfirm}
          onCancel={() => setPendingDrop(null)}
        />
      )}

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
          <span className="kb-record-count">{records.length}</span>
        </div>

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
          {showSettings && workflowSlug && (
            <Link
              to={`/workflows/${workflowSlug}`}
              className="kb-settings-btn"
              title="Workflow Settings"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle
                  cx="7"
                  cy="7"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.636 2.636l1.06 1.06M10.304 10.304l1.06 1.06M11.364 2.636l-1.06 1.06M3.696 10.304l-1.06 1.06"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              Workflow Settings
            </Link>
          )}
          {entityTypeId && (
            <Link
              to={
                typeSlug
                  ? `/records/${typeSlug}/new`
                  : `/entity-types/${entityTypeId}/records/new`
              }
              state={{ workflowId }}
              className="kb-new-btn"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path
                  d="M6.5 1v11M1 6.5h11"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
              New {entityType?.name ?? "Record"}
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
          {typeSlug && (
            <Link to={`/records/${typeSlug}/new`} className="kb-new-btn">
              Create the first one
            </Link>
          )}
        </div>
      ) : (
        <div className="kb-board-scroll">
          <div className="kb-board">
            {columns.map(({ state, recs }) => (
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
        }
        .kb-topbar-left  { display: flex; align-items: center; gap: 10px; }
        .kb-topbar-right { display: flex; align-items: center; gap: 10px; }

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

        .kb-settings-btn {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 500; padding: 7px 14px;
          border-radius: var(--radius-sm);
          background: var(--bg-secondary);
          border: 1px solid var(--border-color);
          color: var(--text-secondary);
          text-decoration: none;
          transition: background var(--transition-fast), color var(--transition-fast);
          white-space: nowrap;
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

        .kb-settings-btn {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; font-weight: 500; padding: 7px 14px;
          border-radius: var(--radius-sm);
          background: var(--bg-secondary); color: var(--text-secondary);
          border: 1px solid var(--border-primary);
          text-decoration: none;
          transition: background var(--transition-fast), color var(--transition-fast);
          white-space: nowrap;
        }
        .kb-settings-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }

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
          background: var(--bg-card);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-sm);
          padding: 11px 12px;
          cursor: grab;
          user-select: none;
          -webkit-user-drag: element;
          transition:
            box-shadow var(--transition-fast),
            transform var(--transition-fast),
            opacity var(--transition-fast),
            border-color var(--transition-fast);
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
      `}</style>
    </div>
  );
}
