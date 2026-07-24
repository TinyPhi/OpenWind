import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";
import type { SavedView } from "../../lib/types.js";
import { useExport } from "../../lib/use-export.js";
import { isRenderableIcon } from "../../lib/icon.js";

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

// ── Module-level drag state ────────────────────────────────────────────────────
// These are set synchronously in dragstart and read synchronously in dragenter.
// React state updates are async — they would be null when dragenter fires in the
// same tick as dragstart.
let _activeDragType: "card" | "column" | null = null;
let _activeDragId: string | null = null; // record id during card drag
let _activeDragCol: string | null = null; // state name during column drag

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
  slug,
}: {
  record: EntityInstance;
  fields: EntityField[];
  slug: string;
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
        e.stopPropagation(); // don't bubble to column header
        e.dataTransfer.setData("text/plain", record.id);
        e.dataTransfer.effectAllowed = "move";
        _activeDragType = "card";
        _activeDragId = record.id;
        // rAF: ghost image is captured BEFORE this runs — dimming doesn't affect ghost
        requestAnimationFrame(() => {
          divRef.current?.classList.add("kb-card--ghost");
        });
      }}
      onDragEnd={() => {
        _activeDragType = null;
        _activeDragId = null;
        divRef.current?.classList.remove("kb-card--ghost");
      }}
      onClick={() => navigate(`/records/${slug}/${record.id}`)}
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
  slug,
  transitions,
  allRecords,
  onCardDrop,
  onColumnDrop,
}: {
  state: WorkflowState | null;
  records: EntityInstance[];
  fields: EntityField[];
  slug: string;
  transitions: Transition[];
  allRecords: EntityInstance[];
  onCardDrop: (recordId: string, toStateName: string) => void;
  onColumnDrop: (fromStateName: string, toStateName: string) => void;
}): React.ReactElement {
  const [dropState, setDropState] = useState<ColDropState>("idle");
  const enterCount = useRef(0);
  const headerRef = useRef<HTMLDivElement>(null);

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

    // Card drop
    const recordId = e.dataTransfer.getData("text/plain") || _activeDragId;
    _activeDragId = null;
    _activeDragType = null;
    if (recordId && state && resolveCardDropState(recordId) === "valid") {
      onCardDrop(recordId, state.name);
    }
  }

  // Clean up if drag ends outside browser window
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
        ref={headerRef}
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
          <RecordCard key={rec.id} record={rec} fields={fields} slug={slug} />
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

      {/* Footer */}
      <div className="kb-col-footer">
        <Link to={`/records/${slug}/new`} className="kb-add-btn">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path
              d="M5.5 1v9M1 5.5h9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          Add item
        </Link>
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function CustomerRecordList(): React.ReactElement {
  const { typeSlug } = useParams<{ typeSlug: string }>();
  const { getTypeBySlug } = useEntityTypes();

  const entityType = typeSlug ? getTypeBySlug(typeSlug) : undefined;
  const entityTypeId = entityType?.id;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [records, setRecords] = useState<EntityInstance[]>([]);
  const [states, setStates] = useState<WorkflowState[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const [transError, setTransError] = useState<string | null>(null);

  // T19: Saved views
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [showSaveViewModal, setShowSaveViewModal] = useState(false);
  const [newViewName, setNewViewName] = useState("");
  const [newViewDefault, setNewViewDefault] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [viewSaveError, setViewSaveError] = useState<string | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const viewsDropdownRef = useRef<HTMLDivElement>(null);

  // T20: Export
  const {
    exportStatus,
    exportError,
    exportDownloadUrl,
    showFormatPicker,
    formatPickerRef,
    setShowFormatPicker,
    handleExport,
    triggerAsyncDownload,
    resetExport,
  } = useExport(entityTypeId);

  // Local column order — allows drag-reorder without a backend call
  const [colOrder, setColOrder] = useState<string[]>([]);

  // Pending drop that needs a modal (requires comment or required fields missing)
  const [pendingDrop, setPendingDrop] = useState<{
    recordId: string;
    toStateName: string;
    transition: Transition;
  } | null>(null);

  const slug = typeSlug ?? "";

  useEffect(() => {
    if (!entityTypeId) return;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(`${API_URL}/entities?entityTypeId=${entityTypeId}`),
      fetchWithAuth(
        `${API_URL}/workflows?${new URLSearchParams({ entityTypeId }).toString()}`,
      ),
    ])
      .then(([fieldsRes, recRes, wfRes]) => {
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        setRecords((recRes as { data?: EntityInstance[] }).data ?? []);
        const wf = (
          wfRes as {
            data?: Array<{
              states?: WorkflowState[];
              transitions?: Transition[];
            }>;
          }
        ).data?.[0];
        const loadedStates = wf?.states ?? [];
        const loadedTransitions = (wf?.transitions ?? []) as Transition[];
        setStates(loadedStates);
        setTransitions(loadedTransitions);
        setColOrder((prev) => {
          if (prev.length === 0) return loadedStates.map((s) => s.name);
          // Merge: keep existing order, remove deleted states, append new ones
          const kept = prev.filter((n) =>
            loadedStates.some((s) => s.name === n),
          );
          const added = loadedStates
            .filter((s) => !prev.includes(s.name))
            .map((s) => s.name);
          return [...kept, ...added];
        });
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [entityTypeId]);

  // T19: Load saved views + auto-apply default
  useEffect(() => {
    if (!entityTypeId) return;
    fetchWithAuth(`${API_URL}/saved-views?entityTypeId=${entityTypeId}`)
      .then((res) => {
        const views = (res as { data?: SavedView[] }).data ?? [];
        setSavedViews(views);
        const def = views.find((v) => v.isDefault);
        if (def) {
          setActiveViewId(def.id);
          setFilterText(def.filterConfig?.search ?? "");
        }
      })
      .catch(() => {
        /* non-critical, ignore */
      });
  }, [entityTypeId]);

  // Close views dropdown on outside click
  useEffect(() => {
    function handle(e: MouseEvent): void {
      if (
        viewsDropdownRef.current &&
        !viewsDropdownRef.current.contains(e.target as Node)
      )
        setViewsOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  async function handleSaveView(): Promise<void> {
    if (!entityTypeId || !newViewName.trim()) return;
    setSavingView(true);
    setViewSaveError(null);
    try {
      const res = await fetchWithAuth(`${API_URL}/saved-views`, {
        method: "POST",
        body: JSON.stringify({
          entityTypeId,
          name: newViewName.trim(),
          filterConfig: { search: filterText },
          sortConfig: {},
          isDefault: newViewDefault,
        }),
      });
      const created = (res as { data?: SavedView }).data;
      if (created) {
        setSavedViews((prev) => {
          // If the new view is the default, clear the old default optimistically
          const cleared = newViewDefault
            ? prev.map((v) => ({ ...v, isDefault: false }))
            : prev;
          return [...cleared, created];
        });
      }
      setShowSaveViewModal(false);
      setNewViewName("");
      setNewViewDefault(false);
    } catch (err) {
      setViewSaveError(
        err instanceof Error ? err.message : "Failed to save view",
      );
    } finally {
      setSavingView(false);
    }
  }

  // Close format picker on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (
        formatPickerRef.current &&
        !formatPickerRef.current.contains(e.target as Node)
      )
        setShowFormatPicker(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Build ordered columns
  const orderedStates: WorkflowState[] = colOrder
    .map((name) => states.find((s) => s.name === name))
    .filter(Boolean) as WorkflowState[];

  // T19: filter records by search text
  const filteredRecords = filterText.trim()
    ? records.filter((rec) => {
        const needle = filterText.toLowerCase();
        return Object.values(rec.fields).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(needle),
        );
      })
    : records;

  const grouped: Record<string, EntityInstance[]> = {};
  const unassigned: EntityInstance[] = [];
  for (const rec of filteredRecords) {
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

  // Reorder columns (local state only)
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

  // Execute a transition (called directly or from modal confirm)
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

      // Optimistic update
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
        // PATCH fields first if any required fields were filled in the modal
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
        // Roll back optimistic update
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

      // Check if we need to show the modal
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

  if (!entityType && !loading) {
    return (
      <div className="kb-page">
        <div className="kb-error">Entity type not found.</div>
      </div>
    );
  }
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
          <h1 className="kb-heading">
            {isRenderableIcon(entityType?.icon) && (
              <span className="kb-heading-icon">{entityType?.icon}</span>
            )}
            {entityType?.plural ?? "Records"}
          </h1>
          <span className="kb-record-count">{filteredRecords.length}</span>
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

          {/* T20: Export format picker */}
          <div ref={formatPickerRef} style={{ position: "relative" }}>
            <button
              className="kb-export-btn"
              onClick={() => setShowFormatPicker(!showFormatPicker)}
              disabled={
                exportStatus === "loading" || exportStatus === "polling"
              }
              title="Export records"
            >
              {exportStatus === "loading"
                ? "Preparing…"
                : exportStatus === "polling"
                  ? "Processing…"
                  : "↓ Export ▾"}
            </button>
            {showFormatPicker && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  background: "var(--bg-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "8px",
                  boxShadow: "var(--shadow-lg)",
                  zIndex: 100,
                  minWidth: "120px",
                  overflow: "hidden",
                }}
              >
                {(
                  [
                    { fmt: "csv", label: "CSV" },
                    { fmt: "xlsx", label: "Excel" },
                    { fmt: "pdf", label: "PDF" },
                  ] as const
                ).map(({ fmt, label }) => (
                  <button
                    key={fmt}
                    onClick={() => void handleExport(fmt)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 14px",
                      fontSize: "13px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-primary)",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "var(--bg-secondary)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "none";
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* T19: Saved views dropdown */}
          <div ref={viewsDropdownRef} style={{ position: "relative" }}>
            <button
              className="kb-views-btn"
              onClick={() => setViewsOpen((o) => !o)}
            >
              {activeViewId
                ? (savedViews.find((v) => v.id === activeViewId)?.name ??
                  "Views")
                : "Views"}
              <span style={{ fontSize: "9px", marginLeft: "4px" }}>▾</span>
            </button>
            {viewsOpen && (
              <div className="kb-views-dropdown">
                <div
                  className="kb-views-item"
                  onClick={() => {
                    setActiveViewId(null);
                    setFilterText("");
                    setViewsOpen(false);
                  }}
                >
                  <span
                    style={{ fontStyle: "italic", color: "var(--text-muted)" }}
                  >
                    Default (no filter)
                  </span>
                </div>
                {savedViews.map((v) => (
                  <div
                    key={v.id}
                    className={`kb-views-item${activeViewId === v.id ? " kb-views-item--active" : ""}`}
                    onClick={() => {
                      setActiveViewId(v.id);
                      setFilterText(v.filterConfig?.search ?? "");
                      setViewsOpen(false);
                    }}
                  >
                    {v.name}
                    {v.isDefault && (
                      <span
                        style={{
                          fontSize: "9px",
                          color: "var(--accent-primary)",
                          marginLeft: "4px",
                        }}
                      >
                        default
                      </span>
                    )}
                  </div>
                ))}
                <div className="kb-views-divider" />
                <div
                  className="kb-views-item kb-views-item--action"
                  onClick={() => {
                    setViewsOpen(false);
                    setNewViewName("");
                    setNewViewDefault(false);
                    setShowSaveViewModal(true);
                  }}
                >
                  + Save current view
                </div>
              </div>
            )}
          </div>

          <Link to={`/records/${slug}/new`} className="kb-new-btn">
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
        </div>
      </div>

      {/* T19: Filter bar */}
      <div
        style={{
          padding: "0 28px 12px",
          display: "flex",
          gap: "10px",
          alignItems: "center",
        }}
      >
        <div style={{ position: "relative", flex: 1, maxWidth: "320px" }}>
          <svg
            style={{
              position: "absolute",
              left: "10px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-muted)",
              pointerEvents: "none",
            }}
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            style={{
              width: "100%",
              paddingLeft: "30px",
              height: "32px",
              fontSize: "13px",
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-primary)",
              outline: "none",
              boxSizing: "border-box",
            }}
            placeholder={`Search ${(entityType?.plural ?? "records").toLowerCase()}…`}
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setActiveViewId(null);
            }}
          />
        </div>
        {filterText && (
          <button
            style={{
              fontSize: "12px",
              color: "var(--text-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 8px",
              borderRadius: "4px",
            }}
            onClick={() => {
              setFilterText("");
              setActiveViewId(null);
            }}
          >
            × Clear
          </button>
        )}
      </div>

      {/* T20: Row count warning (5000–10000 rows) */}
      {records.length >= 5_000 && records.length <= 10_000 && (
        <div
          style={{
            margin: "0 28px 8px",
            padding: "8px 14px",
            background: "hsla(38,92%,50%,.08)",
            color: "var(--warning, #d97706)",
            border: "1px solid hsla(38,92%,50%,.25)",
            borderRadius: "var(--radius-sm)",
            fontSize: "12px",
            fontWeight: 500,
          }}
        >
          Large export — this may take a moment. A download link will appear
          when ready.
        </div>
      )}

      {/* T20: Async polling toast */}
      {exportStatus === "polling" && (
        <div
          style={{
            margin: "0 28px 8px",
            padding: "10px 14px",
            background: "hsla(250,84%,60%,.07)",
            border: "1px solid hsla(250,84%,60%,.2)",
            borderRadius: "var(--radius-sm)",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            color: "var(--accent-primary)",
          }}
        >
          <span
            className="spinner"
            style={{ width: "14px", height: "14px", flexShrink: 0 }}
          />
          Preparing export… you can keep working while this runs.
        </div>
      )}

      {/* T20: Download ready toast */}
      {exportStatus === "ready" && exportDownloadUrl && (
        <div
          style={{
            margin: "0 28px 8px",
            padding: "10px 14px",
            background: "hsla(142,76%,36%,.07)",
            border: "1px solid hsla(142,76%,36%,.2)",
            borderRadius: "var(--radius-sm)",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <span style={{ color: "var(--success)", fontWeight: 500 }}>
            Export ready
          </span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              className="btn-primary btn-sm"
              onClick={triggerAsyncDownload}
            >
              Download
            </button>
            <button
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "16px",
                color: "var(--text-muted)",
              }}
              onClick={resetExport}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* T20: Export error banner */}
      {exportStatus === "error" && exportError && (
        <div
          style={{
            margin: "0 28px 12px",
            padding: "10px 14px",
            background: "var(--danger-light)",
            color: "var(--danger)",
            border: "1px solid hsla(350,80%,60%,.25)",
            borderRadius: "var(--radius-sm)",
            fontSize: "13px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠ {exportError}</span>
          <button
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              fontSize: "16px",
            }}
            onClick={resetExport}
          >
            ×
          </button>
        </div>
      )}

      <div className="kb-divider" />

      {/* T19: Save View modal */}
      {showSaveViewModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1200,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowSaveViewModal(false);
              setViewSaveError(null);
            }
          }}
        >
          <div
            style={{
              background: "var(--bg-primary)",
              border: "1px solid var(--border-color)",
              borderRadius: "14px",
              padding: "24px 28px",
              width: "100%",
              maxWidth: "380px",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <p
              style={{ margin: "0 0 16px", fontWeight: 600, fontSize: "15px" }}
            >
              Save view
            </p>
            <div className="form-group" style={{ marginBottom: "12px" }}>
              <label className="form-label">View name *</label>
              <input
                className="form-input"
                placeholder="e.g. My open tickets"
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                autoFocus
              />
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "13px",
                marginBottom: "20px",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={newViewDefault}
                onChange={(e) => setNewViewDefault(e.target.checked)}
              />
              Set as default view
            </label>
            {viewSaveError && (
              <p
                style={{
                  color: "var(--color-error, #dc2626)",
                  fontSize: "12px",
                  marginBottom: "12px",
                }}
              >
                {viewSaveError}
              </p>
            )}
            <div
              style={{
                display: "flex",
                gap: "10px",
                justifyContent: "flex-end",
              }}
            >
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowSaveViewModal(false);
                  setViewSaveError(null);
                }}
                disabled={savingView}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleSaveView()}
                disabled={savingView || !newViewName.trim()}
              >
                {savingView ? "Saving…" : "Save view"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Board */}
      {filteredRecords.length === 0 && states.length === 0 ? (
        <div className="kb-empty-state">
          <div className="kb-empty-icon">📋</div>
          <p className="kb-empty-title">
            No {(entityType?.plural ?? "records").toLowerCase()} yet
          </p>
          <Link to={`/records/${slug}/new`} className="kb-new-btn">
            Create the first one
          </Link>
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
                slug={slug}
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
      {filteredRecords.length === 0 && records.length > 0 && (
        <div
          style={{
            padding: "40px 28px",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: "13px",
          }}
        >
          No records match &ldquo;{filterText}&rdquo;.{" "}
          <button
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--accent-primary)",
              fontSize: "13px",
            }}
            onClick={() => setFilterText("")}
          >
            Clear filter
          </button>
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

        /* ── Top bar ── */
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

        /* ── Export button (T20) ── */
        .kb-export-btn {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 12px; font-weight: 500; padding: 6px 10px;
          border-radius: var(--radius-sm) 0 0 var(--radius-sm);
          background: var(--bg-secondary); color: var(--text-secondary);
          border: 1px solid var(--border-color); cursor: pointer;
          transition: background 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .kb-export-btn:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
        .kb-export-btn:disabled { opacity: .5; cursor: not-allowed; }
        .kb-export-btn-arrow {
          font-size: 11px; font-weight: 500; padding: 6px 7px;
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
          background: var(--bg-secondary); color: var(--text-muted);
          border: 1px solid var(--border-color); border-left: none;
          cursor: pointer; transition: background 0.15s;
        }
        .kb-export-btn-arrow:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
        .kb-export-btn-arrow:disabled { opacity: .5; cursor: not-allowed; }

        /* ── Views dropdown (T19) ── */
        .kb-views-btn {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 12px; font-weight: 500; padding: 6px 10px;
          border-radius: var(--radius-sm); background: var(--bg-secondary);
          color: var(--text-secondary); border: 1px solid var(--border-color);
          cursor: pointer; white-space: nowrap; transition: background 0.15s;
        }
        .kb-views-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }
        .kb-views-dropdown {
          position: absolute; top: calc(100% + 4px); right: 0;
          width: 200px; background: var(--bg-primary);
          border: 1px solid var(--border-color); border-radius: 10px;
          box-shadow: var(--shadow-lg); z-index: 300;
          overflow: hidden;
        }
        .kb-views-item {
          padding: 9px 14px; font-size: 13px; cursor: pointer;
          color: var(--text-primary); transition: background 0.1s;
        }
        .kb-views-item:hover { background: var(--bg-secondary); }
        .kb-views-item--active { color: var(--accent-primary); font-weight: 600; }
        .kb-views-item--action { color: var(--accent-primary); font-weight: 500; }
        .kb-views-divider { height: 1px; background: var(--border-color); margin: 2px 0; }

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

        /* ── Board ── */
        .kb-board-scroll {
          flex: 1; overflow-x: auto; overflow-y: hidden;
          padding: 20px 28px 24px;
        }
        .kb-board {
          display: flex; gap: 12px; align-items: flex-start;
          min-height: calc(100vh - 185px);
          width: max-content;
        }

        /* ── Column ── */
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
          text-decoration: none; width: 100%;
          transition: color var(--transition-fast), background var(--transition-fast);
        }
        .kb-add-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

        /* ── Card ── */
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
        /* Ghost: opacity only, no pointer-events change — browser keeps drag target alive */
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

        /* ── Empty / error / loading ── */
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

        /* ── Transition modal ── */
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
