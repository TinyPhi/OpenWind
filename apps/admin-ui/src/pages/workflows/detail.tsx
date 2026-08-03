import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  WorkflowCanvas,
  type CanvasDraft,
} from "../../components/workflow-canvas.js";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ConfirmDeleteDialog } from "../../components/confirm-delete-dialog.js";
import { Button, IconButton } from "@platform/ui";

// useBlocker requires a data router (createBrowserRouter), but this app uses
// BrowserRouter. This shim intercepts history.pushState/replaceState to provide
// the same { state, proceed, reset } API without data-router internals.
function useHistoryBlocker(when: boolean): {
  state: "unblocked" | "blocked";
  proceed: () => void;
  reset: () => void;
} {
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  const whenRef = useRef(when);
  useEffect(() => {
    whenRef.current = when;
  }, [when]);

  useEffect(() => {
    const orig = window.history.pushState.bind(window.history);
    const origReplace = window.history.replaceState.bind(window.history);

    function intercept(
      fn: typeof orig,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      if (whenRef.current && url !== null && url !== undefined) {
        setBlockedUrl(typeof url === "string" ? url : url.toString());
        return;
      }
      fn(data, unused, url as string);
    }

    window.history.pushState = (d, u, url) => intercept(orig, d, u, url);
    window.history.replaceState = (d, u, url) =>
      intercept(origReplace, d, u, url);

    return () => {
      window.history.pushState = orig;
      window.history.replaceState = origReplace;
    };
  }, []);

  const proceed = useCallback(() => {
    const url = blockedUrl;
    setBlockedUrl(null);
    if (url) window.history.pushState(null, "", url);
  }, [blockedUrl]);

  const reset = useCallback(() => setBlockedUrl(null), []);

  return {
    state: blockedUrl !== null ? "blocked" : "unblocked",
    proceed,
    reset,
  };
}
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";
import { userManager } from "../../authProvider.js";
import { MultiUserPicker } from "../../components/user-picker.js";
import type { UserOption } from "../../components/user-picker.js";

function toWorkflowSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

type WorkflowState = {
  id: string;
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
  slaHours: number | null;
  sortOrder: number;
};

type WorkflowTransition = {
  id: string;
  fromState: string;
  toState: string;
  label: string;
  allowedRoles: string[];
  requiresComment: boolean;
  requiresFields: string[];
};

type WorkflowFull = {
  id: string;
  name: string;
  entityTypeId: string;
  initialState: string;
  isActive: boolean;
  createdBy: string | null;
  assignedTo: string[] | null;
  createdAt: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  maxChildDepth: number | null;
  maxChildrenPerParent: number | null;
};

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isIndexed: boolean;
  sortOrder: number;
};

type AddFieldForm = {
  name: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
};

const EMPTY_FIELD: AddFieldForm = {
  name: "",
  label: "",
  fieldType: "text",
  isRequired: false,
};

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "longtext", label: "Long Text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "date", label: "Date" },
  { value: "boolean", label: "Boolean" },
  { value: "enum", label: "Enum (select)" },
];

type AddStateForm = {
  name: string;
  label: string;
  color: string;
  isTerminal: boolean;
  slaHours: string;
  sortOrder: string;
};

type AddTransitionForm = {
  fromState: string;
  toState: string;
  label: string;
  allowedRoles: string[];
  requiresComment: boolean;
};

const EMPTY_STATE: AddStateForm = {
  name: "",
  label: "",
  color: "#6366f1",
  isTerminal: false,
  slaHours: "",
  sortOrder: "0",
};

const EMPTY_TRANSITION: AddTransitionForm = {
  fromState: "",
  toState: "",
  label: "",
  allowedRoles: [],
  requiresComment: false,
};

function StateDot({ color }: { color: string | null }): React.ReactElement {
  return (
    <span
      className="state-dot"
      style={{ backgroundColor: color ?? "var(--accent-primary)" }}
    />
  );
}

/* ── Sortable field row (drag-and-drop reorder on Fields tab) ── */
function SortableFieldRow({
  field,
  children,
  dragDisabled,
}: {
  field: EntityField;
  children: React.ReactNode;
  dragDisabled: boolean;
}): React.ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id, disabled: dragDisabled });

  return (
    <tr
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
        opacity: isDragging ? 0.5 : 1,
        background: isDragging ? "var(--bg-secondary)" : undefined,
      }}
    >
      <td style={{ width: "28px", padding: "0 0 0 8px" }}>
        {!dragDisabled && (
          <span
            {...attributes}
            {...listeners}
            style={{
              cursor: "grab",
              display: "inline-flex",
              color: "var(--text-tertiary)",
              touchAction: "none",
            }}
            title="Drag to reorder"
          >
            <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
              <circle cx="3" cy="2.5" r="1.2" fill="currentColor" />
              <circle cx="7" cy="2.5" r="1.2" fill="currentColor" />
              <circle cx="3" cy="7" r="1.2" fill="currentColor" />
              <circle cx="7" cy="7" r="1.2" fill="currentColor" />
              <circle cx="3" cy="11.5" r="1.2" fill="currentColor" />
              <circle cx="7" cy="11.5" r="1.2" fill="currentColor" />
            </svg>
          </span>
        )}
      </td>
      {children}
    </tr>
  );
}

/* ── State Edit Popover (T16) ───────────────────────────────── */
function StateEditPopover({
  state,
  workflowId,
  anchorLeft,
  onSave,
  onClose,
}: {
  state: WorkflowState;
  workflowId: string | null;
  anchorLeft: number;
  onSave: () => void;
  onClose: () => void;
}): React.ReactElement {
  const [form, setForm] = useState({
    label: state.label,
    color: state.color ?? "#6366f1",
    slaHours: state.slaHours !== null ? String(state.slaHours) : "",
    isTerminal: state.isTerminal,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node))
        onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  async function handleSave(): Promise<void> {
    if (!workflowId) return;
    setSaving(true);
    setError(null);
    try {
      await fetchWithAuth(
        `${API_URL}/workflows/${workflowId}/states/${state.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            label: form.label.trim(),
            color: form.color || undefined,
            slaHours: form.slaHours ? parseInt(form.slaHours, 10) : null,
            isTerminal: form.isTerminal,
          }),
        },
      );
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={popoverRef}
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        left: Math.max(0, anchorLeft),
        width: "240px",
        background: "var(--bg-primary)",
        border: "1px solid var(--border-color)",
        borderRadius: "12px",
        boxShadow: "var(--shadow-lg)",
        padding: "16px",
        zIndex: 200,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: "13px" }}>
          Edit: <code style={{ fontSize: "11px" }}>{state.name}</code>
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "16px",
            color: "var(--text-muted)",
            lineHeight: 1,
            padding: "0 2px",
          }}
        >
          ×
        </button>
      </div>

      <div className="form-group" style={{ marginBottom: "10px" }}>
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={form.label}
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          autoFocus
        />
      </div>

      <div className="form-group" style={{ marginBottom: "10px" }}>
        <label className="form-label">Color</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="color"
            value={form.color}
            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            style={{
              width: "36px",
              height: "32px",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          />
          <input
            className="form-input"
            value={form.color}
            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            style={{ flex: 1, fontSize: "12px" }}
          />
        </div>
      </div>

      <div className="form-group" style={{ marginBottom: "10px" }}>
        <label className="form-label">Deadline reminder (hours)</label>
        <input
          type="number"
          className="form-input"
          min={1}
          placeholder="e.g. 24"
          value={form.slaHours}
          onChange={(e) => setForm((f) => ({ ...f, slaHours: e.target.value }))}
        />
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
          marginBottom: "14px",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={form.isTerminal}
          onChange={(e) =>
            setForm((f) => ({ ...f, isTerminal: e.target.checked }))
          }
        />
        <span>
          This is a final step
          <br />
          <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
            Tickets won&apos;t move further once they reach this step
          </span>
        </span>
      </label>

      {error && (
        <div
          className="alert alert-error"
          style={{ marginBottom: "10px", fontSize: "12px" }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <Button
          variant="secondary"
          onClick={onClose}
          disabled={saving}
          style={{ fontSize: "12px" }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saving || !form.label.trim()}
          style={{ fontSize: "12px" }}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/* ── Sortable state node (T17) ──────────────────────────────── */
function SortableStateNode({
  state,
  isInitial,
  isLast,
  onEdit,
  setRef,
}: {
  state: WorkflowState;
  isInitial: boolean;
  isLast: boolean;
  onEdit: () => void;
  setRef: (el: HTMLDivElement | null) => void;
}): React.ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: state.id });
  const accent = state.color ?? "var(--accent-primary)";

  function handleRef(el: HTMLDivElement | null): void {
    // useSortable.setNodeRef expects Element | null; our custom map stores HTMLDivElement.
    // The double cast bridges the type gap — the runtime value is the same HTMLDivElement.
    setNodeRef(el as unknown as HTMLElement);
    setRef(el);
  }

  return (
    <React.Fragment>
      <div
        ref={handleRef}
        style={{
          transform: CSS.Transform.toString(transform),
          transition: transition ?? undefined,
          opacity: isDragging ? 0.45 : 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "6px",
          minWidth: "90px",
          cursor: "grab",
        }}
        {...attributes}
        {...listeners}
      >
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            background: `${accent}22`,
            border: `2px solid ${accent}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            cursor: "pointer",
            transition: "box-shadow 0.15s",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          title="Click to edit step"
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.boxShadow =
              `0 0 0 3px ${accent}44`;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.boxShadow = "none";
          }}
        >
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: accent,
              display: "block",
            }}
          />
          {isInitial && (
            <span
              style={{
                position: "absolute",
                top: "-8px",
                left: "50%",
                transform: "translateX(-50%)",
                fontSize: "9px",
                fontWeight: 700,
                color: "var(--accent-primary)",
                letterSpacing: "0.3px",
                whiteSpace: "nowrap",
              }}
            >
              START
            </span>
          )}
          {state.isTerminal && (
            <span
              style={{
                position: "absolute",
                bottom: "-8px",
                left: "50%",
                transform: "translateX(-50%)",
                fontSize: "9px",
                fontWeight: 700,
                color: "var(--text-muted)",
                letterSpacing: "0.3px",
                whiteSpace: "nowrap",
              }}
            >
              END
            </span>
          )}
        </div>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--text-primary)",
              lineHeight: 1.2,
            }}
          >
            {state.label}
          </div>
          {state.slaHours !== null && (
            <div
              style={{
                fontSize: "10px",
                color: "var(--warning)",
                fontWeight: 600,
                marginTop: "2px",
              }}
            >
              Deadline: {state.slaHours}h
            </div>
          )}
        </div>
      </div>
      {!isLast && (
        <div
          style={{
            flex: 1,
            minWidth: "24px",
            height: "2px",
            background: "var(--border-color)",
            position: "relative",
            top: "-12px",
            margin: "0 4px",
          }}
        >
          <span
            style={{
              position: "absolute",
              right: "-4px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-muted)",
              fontSize: "14px",
              lineHeight: 1,
            }}
          >
            ›
          </span>
        </div>
      )}
    </React.Fragment>
  );
}

/* ── UX4G Pipeline Flow (T16 + T17 + T18) ──────────────────── */
function StateFlowDiagram({
  states,
  transitions,
  initialState,
  workflowId,
  onStateUpdated,
}: {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  initialState: string;
  workflowId: string | null;
  onStateUpdated: () => void;
}): React.ReactElement {
  const [localStates, setLocalStates] = useState(() =>
    [...states].sort((a, b) => a.sortOrder - b.sortOrder),
  );
  const [popoverState, setPopoverState] = useState<WorkflowState | null>(null);
  const [popoverLeft, setPopoverLeft] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [nodeCenters, setNodeCenters] = useState<Record<string, number>>({});
  const [containerWidth, setContainerWidth] = useState(0);

  // Sync when parent refetches
  useEffect(() => {
    setLocalStates([...states].sort((a, b) => a.sortOrder - b.sortOrder));
  }, [states]);

  const measureNodes = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const centers: Record<string, number> = {};
    for (const [sid, el] of nodeRefs.current) {
      const rect = el.getBoundingClientRect();
      centers[sid] = rect.left + rect.width / 2 - containerRect.left;
    }
    setNodeCenters(centers);
    setContainerWidth(containerRect.width);
  }, []);

  // Re-measure when state list changes (nodes added/removed/reordered).
  useLayoutEffect(() => {
    measureNodes();
  }, [localStates, measureNodes]);

  // Re-measure on container resize so SVG arcs stay accurate after window resize.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(measureNodes);
    ro.observe(container);
    return () => ro.disconnect();
  }, [measureNodes]);

  const sensors = useSensors(useSensor(PointerSensor));

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    const { active, over } = event;
    if (!over || active.id === over.id || !workflowId) return;

    const oldIndex = localStates.findIndex((s) => s.id === active.id);
    const newIndex = localStates.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(localStates, oldIndex, newIndex).map(
      (s, i) => ({
        ...s,
        sortOrder: i * 10,
      }),
    );

    // Optimistic
    setLocalStates(reordered);

    const snapshot = localStates;
    // Build id→sortOrder map from snapshot so we compare by identity, not position.
    // Comparing reordered[i] against snapshot[i] is wrong: after a drag they are different states.
    const oldOrderMap = new Map(snapshot.map((s) => [s.id, s.sortOrder]));
    try {
      await Promise.all(
        reordered
          .filter((s) => s.sortOrder !== (oldOrderMap.get(s.id) ?? -1))
          .map((s) =>
            fetchWithAuth(`${API_URL}/workflows/${workflowId}/states/${s.id}`, {
              method: "PATCH",
              body: JSON.stringify({ sortOrder: s.sortOrder }),
            }),
          ),
      );
      onStateUpdated();
    } catch {
      setLocalStates(snapshot);
    }
  }

  function openPopover(state: WorkflowState): void {
    setPopoverState(state);
    const el = nodeRefs.current.get(state.id);
    const container = containerRef.current;
    if (el && container) {
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setPopoverLeft(elRect.left - containerRect.left + elRect.width / 2 - 120);
    }
  }

  // T18: SVG arcs for non-adjacent transitions
  const stateIndexMap = new Map(localStates.map((s, i) => [s.name, i]));
  const nonAdjacentTransitions = transitions.filter((t) => {
    const fromIdx = stateIndexMap.get(t.fromState) ?? -1;
    const toIdx = stateIndexMap.get(t.toState) ?? -1;
    return fromIdx >= 0 && toIdx >= 0 && Math.abs(fromIdx - toIdx) > 1;
  });
  const maxArcHeight =
    nonAdjacentTransitions.length > 0
      ? Math.max(
          ...nonAdjacentTransitions.map((t) => {
            const gap =
              Math.abs(
                (stateIndexMap.get(t.fromState) ?? 0) -
                  (stateIndexMap.get(t.toState) ?? 0),
              ) - 1;
            return gap * 18 + 20;
          }),
        )
      : 0;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(e) => void handleDragEnd(e)}
      >
        <SortableContext
          items={localStates.map((s) => s.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0",
              flexWrap: "wrap",
              padding: "8px 0 4px",
            }}
          >
            {localStates.map((state, i) => (
              <SortableStateNode
                key={state.id}
                state={state}
                isInitial={state.name === initialState}
                isLast={i === localStates.length - 1}
                onEdit={() => openPopover(state)}
                setRef={(el) => {
                  if (el) nodeRefs.current.set(state.id, el);
                  else nodeRefs.current.delete(state.id);
                }}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* SVG arcs for non-adjacent transitions (T18) */}
      {nonAdjacentTransitions.length > 0 && containerWidth > 0 && (
        <svg
          width={containerWidth}
          height={maxArcHeight}
          style={{
            display: "block",
            overflow: "visible",
            pointerEvents: "none",
          }}
        >
          <defs>
            <marker
              id="arc-arrow"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path
                d="M 0 0 L 6 3 L 0 6 Z"
                fill="var(--accent-primary)"
                opacity="0.55"
              />
            </marker>
          </defs>
          {nonAdjacentTransitions.map((t) => {
            const fromState = localStates.find((s) => s.name === t.fromState);
            const toState = localStates.find((s) => s.name === t.toState);
            if (!fromState || !toState) return null;
            const x1 = nodeCenters[fromState.id] ?? 0;
            const x2 = nodeCenters[toState.id] ?? 0;
            const gap =
              Math.abs(
                (stateIndexMap.get(t.fromState) ?? 0) -
                  (stateIndexMap.get(t.toState) ?? 0),
              ) - 1;
            const arcH = gap * 18 + 20;
            const cx = (x1 + x2) / 2;
            return (
              <path
                key={t.id}
                d={`M ${x1} 4 Q ${cx} ${arcH} ${x2} 4`}
                fill="none"
                stroke="var(--accent-primary)"
                strokeWidth="1.5"
                strokeDasharray="5 3"
                opacity="0.55"
                markerEnd="url(#arc-arrow)"
              />
            );
          })}
        </svg>
      )}

      {/* State inline edit popover (T16) */}
      {popoverState && (
        <StateEditPopover
          state={popoverState}
          workflowId={workflowId}
          anchorLeft={popoverLeft}
          onSave={() => {
            setPopoverState(null);
            onStateUpdated();
          }}
          onClose={() => setPopoverState(null)}
        />
      )}
    </div>
  );
}

/* ── KPI Chip ───────────────────────────────────────────────── */
function KpiChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: string;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
        padding: "10px 20px",
        background: "var(--bg-card)",
        border: "1px solid var(--border-color)",
        borderTop: `3px solid ${accent}`,
        borderRadius: "8px",
        minWidth: "90px",
      }}
    >
      <span
        style={{
          fontSize: "20px",
          fontWeight: 700,
          color: accent,
          lineHeight: 1,
          fontFamily: "var(--font-heading)",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: "10px",
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {label}
      </span>
    </div>
  );
}

/* ── Section Header ─────────────────────────────────────────── */
function SectionHeader({
  label,
  count,
  action,
}: {
  label: string;
  count?: number;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span
          style={{
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.8px",
          }}
        >
          {label}
        </span>
        {count !== undefined && (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "var(--accent-primary)",
              background: "hsla(250,84%,60%,.1)",
              border: "1px solid hsla(250,84%,60%,.2)",
              borderRadius: "20px",
              padding: "1px 8px",
            }}
          >
            {count}
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

export function WorkflowDetail(): React.ReactElement {
  const { workflowSlug } = useParams<{ workflowSlug: string }>();
  const navigate = useNavigate();
  useEntityTypes();

  // Resolve slug → UUID once on mount. Uses the dedicated, ownership-unfiltered
  // /workflows/slugs endpoint — the main list is filtered to workflows the
  // caller admins, which would strand a since-removed admin on an infinite
  // spinner (id never resolves, so the detail fetch never runs).
  const [id, setId] = useState<string | null>(null);
  const [slugNotFound, setSlugNotFound] = useState(false);
  useEffect(() => {
    if (!workflowSlug) return;
    fetchWithAuth(`${API_URL}/workflows/slugs`)
      .then((res) => {
        const all =
          (res as { data?: Array<{ id: string; name: string }> }).data ?? [];
        const match = all.find((w) => toWorkflowSlug(w.name) === workflowSlug);
        if (match) setId(match.id);
        else setSlugNotFound(true);
      })
      .catch(() => setSlugNotFound(true));
  }, [workflowSlug]);

  const [data, setData] = useState<{ data: WorkflowFull } | undefined>(
    undefined,
  );
  const [isLoading, setIsLoading] = useState(true);

  // GET /workflows/:id is open to any tenant member (states/transitions
  // aren't sensitive, and ticket assignees need them to work with their
  // records) — this settings page enforces the real "workflow admin only"
  // gate itself, client-side, further down using workflow.createdBy/assignedTo.
  const refetch = useCallback(async (): Promise<void> => {
    if (!id) return;
    setIsLoading(true);
    try {
      const res = await fetchWithAuth(`${API_URL}/workflows/${id}`);
      setData(res as { data: WorkflowFull });
    } catch {
      setData(undefined);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const [fields, setFields] = useState<EntityField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [showAddField, setShowAddField] = useState(false);
  const [fieldForm, setFieldForm] = useState<AddFieldForm>(EMPTY_FIELD);
  const [savingField, setSavingField] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [deletingFieldId, setDeletingFieldId] = useState<string | null>(null);

  const [showAddState, setShowAddState] = useState(false);
  const [stateForm, setStateForm] = useState<AddStateForm>(EMPTY_STATE);
  const [savingState, setSavingState] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const [deletingStateId, setDeletingStateId] = useState<string | null>(null);

  const [showAddTransition, setShowAddTransition] = useState(false);
  const [transForm, setTransForm] =
    useState<AddTransitionForm>(EMPTY_TRANSITION);
  const [savingTrans, setSavingTrans] = useState(false);
  const [transError, setTransError] = useState<string | null>(null);
  const [deletingTransId, setDeletingTransId] = useState<string | null>(null);

  const [editingField, setEditingField] = useState<EntityField | null>(null);
  const [editingState, setEditingState] = useState<WorkflowState | null>(null);
  const [editingTransition, setEditingTransition] =
    useState<WorkflowTransition | null>(null);

  const [showDeleteWorkflow, setShowDeleteWorkflow] = useState(false);
  const [deletingWorkflow, setDeletingWorkflow] = useState(false);
  const [deleteWorkflowError, setDeleteWorkflowError] = useState<string | null>(
    null,
  );

  const [activeTab, setActiveTab] = useState<
    "canvas" | "states" | "transitions" | "fields" | "settings"
  >("settings");
  const [togglingActive, setTogglingActive] = useState(false);
  const [canvasView, setCanvasView] = useState<"canvas" | "pipeline">("canvas");
  const [canvasDirty, setCanvasDirty] = useState(false);

  const blocker = useHistoryBlocker(canvasDirty);

  // Warn on browser refresh/tab-close when canvas has unsaved changes
  useEffect(() => {
    if (!canvasDirty) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [canvasDirty]);

  const workflowName = (data?.data as { name?: string } | undefined)?.name;
  useEffect(() => {
    if (!workflowName) return;
    document.title = canvasDirty
      ? `● ${workflowName} — Workflow`
      : `${workflowName} — Workflow`;
    return () => {
      document.title = "OpenWind";
    };
  }, [canvasDirty, workflowName]);

  async function handleCanvasSave(draft: CanvasDraft): Promise<void> {
    if (!id) throw new Error("Workflow ID missing");
    await fetchWithAuth(`${API_URL}/workflows/${id}/canvas`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
    void refetch();
  }

  // Current user identity for access control
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserRoles, setCurrentUserRoles] = useState<string[]>([]);
  useEffect(() => {
    userManager
      .getUser()
      .then((u) => {
        if (!u) return;
        setCurrentUserId(u.profile.sub);
        const roleClaim = u.profile["urn:zitadel:iam:org:project:roles"] as
          | Record<string, unknown>
          | undefined;
        setCurrentUserRoles(roleClaim ? Object.keys(roleClaim) : []);
      })
      .catch(() => {
        /* leave defaults */
      });
  }, []);

  // Child ticket settings
  const [maxChildDepth, setMaxChildDepth] = useState<string>("1");
  const [maxChildrenPerParent, setMaxChildrenPerParent] =
    useState<string>("10");
  const [savingChildSettings, setSavingChildSettings] = useState(false);

  useEffect(() => {
    if (data?.data) {
      const wf = data.data as WorkflowFull;
      setMaxChildDepth(String(wf.maxChildDepth ?? 1));
      setMaxChildrenPerParent(String(wf.maxChildrenPerParent ?? 10));
    }
  }, [data?.data]);

  async function handleSaveChildSettings(): Promise<void> {
    if (!id) return;
    setSavingChildSettings(true);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          maxChildDepth: maxChildDepth === "" ? null : Number(maxChildDepth),
          maxChildrenPerParent:
            maxChildrenPerParent === "" ? null : Number(maxChildrenPerParent),
        }),
      });
      void refetch();
    } catch {
      // ignore
    } finally {
      setSavingChildSettings(false);
    }
  }

  // User assignment
  const [orgUsers, setOrgUsers] = useState<UserOption[]>([]);
  const [assignedTo, setAssignedTo] = useState<string[]>([]);
  const [savingAssign, setSavingAssign] = useState(false);

  // Available roles from Zitadel (for transition role picker)
  const [availableRoles, setAvailableRoles] = useState<string[]>([]);

  useEffect(() => {
    fetchWithAuth(`${API_URL}/roles`)
      .then((res) => {
        setAvailableRoles((res as { data?: string[] }).data ?? []);
      })
      .catch(() => {
        setAvailableRoles(["admin", "agent", "user"]);
      });
  }, []);

  useEffect(() => {
    fetchWithAuth(`${API_URL}/users`)
      .then((res) => {
        setOrgUsers((res as { data?: UserOption[] }).data ?? []);
      })
      .catch(() => {
        /* users list unavailable — picker stays empty */
      });
  }, []);

  useEffect(() => {
    if (data?.data) {
      setAssignedTo((data.data as WorkflowFull).assignedTo ?? []);
    }
  }, [data?.data]);

  async function handleAssign(userIds: string[]): Promise<void> {
    if (!id) return;
    // The creator can never be removed from the list except by a global
    // admin — the MultiUserPicker lets any current chip be unchecked, so
    // re-insert the creator here rather than let a doomed 422 round-trip.
    const creatorId = workflow?.createdBy;
    const nextIds =
      !isAdmin && creatorId && !userIds.includes(creatorId)
        ? [...userIds, creatorId]
        : userIds;

    setSavingAssign(true);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo: nextIds }),
      });
      setAssignedTo(nextIds);
      void refetch();
    } catch {
      // ignore — keep current assignment
    } finally {
      setSavingAssign(false);
    }
  }

  async function handleToggleActive(): Promise<void> {
    if (!id || !workflow) return;
    setTogglingActive(true);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !workflow.isActive }),
      });
      void refetch();
    } catch {
      // ignore — refetch will keep current state
    } finally {
      setTogglingActive(false);
    }
  }

  const [confirmDelete, setConfirmDelete] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const fieldSensors = useSensors(useSensor(PointerSensor));

  const fetchFields = useCallback((entityTypeId: string): void => {
    setFieldsLoading(true);
    fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`)
      .then((res) => {
        setFields((res as { data?: EntityField[] }).data ?? []);
      })
      .catch(() => setFields([]))
      .finally(() => setFieldsLoading(false));
  }, []);

  const entityTypeId = data?.data.entityTypeId;
  useEffect(() => {
    if (entityTypeId) fetchFields(entityTypeId);
  }, [entityTypeId, fetchFields]);

  async function handleAddField(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!workflow?.entityTypeId) return;
    setSavingField(true);
    setFieldError(null);
    try {
      await fetchWithAuth(
        `${API_URL}/entity-types/${workflow.entityTypeId}/fields`,
        {
          method: "POST",
          body: JSON.stringify({
            name: fieldForm.name.trim(),
            label: fieldForm.label.trim(),
            fieldType: fieldForm.fieldType,
            isRequired: fieldForm.isRequired,
          }),
        },
      );
      setShowAddField(false);
      setFieldForm(EMPTY_FIELD);
      fetchFields(workflow.entityTypeId);
    } catch (err) {
      setFieldError(
        err instanceof Error ? err.message : "Failed to add detail",
      );
    } finally {
      setSavingField(false);
    }
  }

  async function handleFieldDragEnd(event: DragEndEvent): Promise<void> {
    const { active, over } = event;
    if (!over || active.id === over.id || !workflow?.entityTypeId) return;

    const sorted = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
    const oldIndex = sorted.findIndex((f) => f.id === active.id);
    const newIndex = sorted.findIndex((f) => f.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(sorted, oldIndex, newIndex).map((f, i) => ({
      ...f,
      sortOrder: i * 10,
    }));

    const snapshot = fields;
    const oldOrderMap = new Map(sorted.map((f) => [f.id, f.sortOrder]));
    setFields(reordered);
    try {
      await Promise.all(
        reordered
          .filter((f) => f.sortOrder !== (oldOrderMap.get(f.id) ?? -1))
          .map((f) =>
            fetchWithAuth(
              `${API_URL}/entity-types/${workflow.entityTypeId}/fields/${f.id}`,
              {
                method: "PATCH",
                body: JSON.stringify({ sortOrder: f.sortOrder }),
              },
            ),
          ),
      );
    } catch (err) {
      setFields(snapshot);
      setInlineError(
        err instanceof Error ? err.message : "Failed to reorder details",
      );
    }
  }

  async function handleDeleteField(fieldId: string): Promise<void> {
    if (!workflow?.entityTypeId) return;
    setDeletingFieldId(fieldId);
    try {
      await fetchWithAuth(
        `${API_URL}/entity-types/${workflow.entityTypeId}/fields/${fieldId}`,
        { method: "DELETE" },
      );
      fetchFields(workflow.entityTypeId);
    } catch (err) {
      setInlineError(
        err instanceof Error ? err.message : "Failed to delete detail",
      );
    } finally {
      setDeletingFieldId(null);
    }
  }

  async function handleEditField(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!workflow?.entityTypeId || !editingField) return;
    setSavingField(true);
    setFieldError(null);
    try {
      await fetchWithAuth(
        `${API_URL}/entity-types/${workflow.entityTypeId}/fields/${editingField.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            label: fieldForm.label.trim(),
            isRequired: fieldForm.isRequired,
          }),
        },
      );
      setEditingField(null);
      setFieldForm(EMPTY_FIELD);
      fetchFields(workflow.entityTypeId);
    } catch (err) {
      setFieldError(
        err instanceof Error ? err.message : "Failed to edit detail",
      );
    } finally {
      setSavingField(false);
    }
  }

  async function handleAddState(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!id) return;
    setSavingState(true);
    setStateError(null);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}/states`, {
        method: "POST",
        body: JSON.stringify({
          name: stateForm.name.trim(),
          label: stateForm.label.trim(),
          color: stateForm.color || undefined,
          isTerminal: stateForm.isTerminal,
          slaHours: stateForm.slaHours ? parseInt(stateForm.slaHours) : null,
          sortOrder: parseInt(stateForm.sortOrder) || 0,
        }),
      });
      setShowAddState(false);
      setStateForm(EMPTY_STATE);
      void refetch();
    } catch (err) {
      setStateError(err instanceof Error ? err.message : "Failed to add step");
    } finally {
      setSavingState(false);
    }
  }

  async function handleDeleteState(stateId: string): Promise<void> {
    if (!id) return;
    setDeletingStateId(stateId);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}/states/${stateId}`, {
        method: "DELETE",
      });
      void refetch();
    } catch (err) {
      setInlineError(
        err instanceof Error ? err.message : "Failed to delete step",
      );
    } finally {
      setDeletingStateId(null);
    }
  }

  async function handleEditState(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!id || !editingState) return;
    setSavingState(true);
    setStateError(null);
    try {
      await fetchWithAuth(
        `${API_URL}/workflows/${id}/states/${editingState.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: stateForm.name.trim(),
            label: stateForm.label.trim(),
            color: stateForm.color || undefined,
            isTerminal: stateForm.isTerminal,
            slaHours: stateForm.slaHours ? parseInt(stateForm.slaHours) : null,
            sortOrder: parseInt(stateForm.sortOrder) || 0,
          }),
        },
      );
      setEditingState(null);
      setStateForm(EMPTY_STATE);
      void refetch();
    } catch (err) {
      setStateError(err instanceof Error ? err.message : "Failed to edit step");
    } finally {
      setSavingState(false);
    }
  }

  async function handleAddTransition(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!id) return;
    setSavingTrans(true);
    setTransError(null);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}/transitions`, {
        method: "POST",
        body: JSON.stringify({
          fromState: transForm.fromState.trim(),
          toState: transForm.toState.trim(),
          label: transForm.label.trim() || undefined,
          allowedRoles:
            transForm.allowedRoles.length > 0
              ? transForm.allowedRoles
              : undefined,
          requiresComment: transForm.requiresComment,
        }),
      });
      setShowAddTransition(false);
      setTransForm(EMPTY_TRANSITION);
      void refetch();
    } catch (err) {
      setTransError(
        err instanceof Error ? err.message : "Failed to add action",
      );
    } finally {
      setSavingTrans(false);
    }
  }

  async function handleDeleteTransition(transId: string): Promise<void> {
    if (!id) return;
    setDeletingTransId(transId);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}/transitions/${transId}`, {
        method: "DELETE",
      });
      void refetch();
    } catch (err) {
      setInlineError(
        err instanceof Error ? err.message : "Failed to delete action",
      );
    } finally {
      setDeletingTransId(null);
    }
  }

  async function handleEditTransition(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!id || !editingTransition) return;
    setSavingTrans(true);
    setTransError(null);
    try {
      await fetchWithAuth(
        `${API_URL}/workflows/${id}/transitions/${editingTransition.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            label: transForm.label.trim() || null,
            allowedRoles: transForm.allowedRoles,
            requiresComment: transForm.requiresComment,
          }),
        },
      );
      setEditingTransition(null);
      setTransForm(EMPTY_TRANSITION);
      void refetch();
    } catch (err) {
      setTransError(
        err instanceof Error ? err.message : "Failed to edit action",
      );
    } finally {
      setSavingTrans(false);
    }
  }

  async function handleDeleteWorkflow(): Promise<void> {
    if (!id) return;
    setDeletingWorkflow(true);
    setDeleteWorkflowError(null);
    try {
      await fetchWithAuth(`${API_URL}/workflows/${id}`, { method: "DELETE" });
      navigate("/workflows");
    } catch (err) {
      setDeleteWorkflowError(
        err instanceof Error ? err.message : "Failed to delete workflow",
      );
      setDeletingWorkflow(false);
    }
  }

  const workflow = data?.data;

  if (slugNotFound || (!isLoading && !workflow)) {
    return (
      <div className="empty-state">
        <h4>Workflow not found</h4>
        <Link
          to="/workflows"
          className="back-link"
          style={{ marginTop: "12px", display: "inline-block" }}
        >
          ← Back to Workflows
        </Link>
      </div>
    );
  }

  if (isLoading || !workflow) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading workflow…</span>
      </div>
    );
  }

  const isAdmin = currentUserRoles.includes("admin");

  // GET /workflows/:id is open to any tenant member (ticket assignees need
  // states/transitions to work with their records), so this admin-only
  // settings page enforces its own gate here, client-side, using the
  // createdBy/assignedTo the fetch already returned.
  const canManageWorkflow =
    isAdmin ||
    (currentUserId !== null &&
      (currentUserId === workflow.createdBy ||
        (workflow.assignedTo?.includes(currentUserId) ?? false)));

  if (!canManageWorkflow) {
    const creator = workflow.createdBy
      ? orgUsers.find((u) => u.userId === workflow.createdBy)
      : undefined;
    const creatorName = creator?.displayName ?? workflow.createdBy;

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "60vh",
        }}
      >
        <div
          className="data-panel"
          style={{
            maxWidth: "440px",
            width: "100%",
            padding: "32px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              background: "hsla(0,84%,60%,.1)",
              color: "var(--danger)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 16px",
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <h3 style={{ marginBottom: "8px" }}>No access to this workflow</h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
              lineHeight: 1.6,
              marginBottom: "20px",
            }}
          >
            {creatorName ? (
              <>
                You're not an admin of this workflow. Contact{" "}
                <strong style={{ color: "var(--text-primary)" }}>
                  {creatorName}
                </strong>
                , its creator, to request access.
              </>
            ) : (
              "You're not an admin of this workflow. Contact a workflow admin to request access."
            )}
          </p>
          <Link to="/workflows" className="btn btn-secondary">
            ← Back to Workflows
          </Link>
        </div>
      </div>
    );
  }

  // Only the creator or a global admin can edit the admin list itself
  // (add/remove entries); other admins can manage the workflow but not this
  // list. The creator can never remove themselves — only a global admin can.
  const isAdminListEditor =
    isAdmin || (currentUserId !== null && currentUserId === workflow.createdBy);

  const sortedStates = [...workflow.states].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const stateNames = sortedStates.map((s) => s.name);
  const slaStates = workflow.states.filter((s) => s.slaHours !== null).length;

  const TABS = [
    { id: "settings" as const, label: "Settings" },
    { id: "canvas" as const, label: "Canvas" },
    { id: "states" as const, label: "Steps", count: workflow.states.length },
    {
      id: "transitions" as const,
      label: "Actions",
      count: workflow.transitions.length,
    },
    {
      id: "fields" as const,
      label: "Details to Collect",
      count: fieldsLoading ? undefined : fields.length,
    },
  ] as const;

  return (
    <div>
      {/* ── Breadcrumb ─────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginBottom: "20px",
          fontSize: "12px",
          color: "var(--text-muted)",
        }}
      >
        <Link
          to="/workflows"
          style={{
            color: "var(--accent-primary)",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Workflows
        </Link>
        <span>/</span>
        <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
          {workflow.name}
        </span>
      </div>

      {/* ── Top info card ──────────────────────────────────── */}
      <div
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: "8px",
          padding: "24px 28px",
          marginBottom: "20px",
          borderLeft: "4px solid var(--accent-primary)",
        }}
      >
        <div
          className="wfd-page-inner"
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "20px",
            flexWrap: "wrap",
          }}
        >
          {/* Left: title block */}
          <div
            style={{ display: "flex", alignItems: "flex-start", gap: "16px" }}
          >
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "12px",
                background: "hsla(250,84%,60%,.12)",
                border: "1px solid hsla(250,84%,60%,.25)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2"
                stroke="var(--accent-primary)"
                style={{ width: "22px", height: "22px" }}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69zM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z"
                />
              </svg>
            </div>
            <div>
              <h2
                className="wfd-page-title"
                style={{
                  margin: "0 0 8px",
                  fontSize: "22px",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-heading)",
                }}
              >
                {workflow.name}
              </h2>
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    fontSize: "12px",
                    fontWeight: 600,
                  }}
                >
                  <span
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "50%",
                      background: workflow.isActive
                        ? "var(--success)"
                        : "var(--text-muted)",
                      display: "inline-block",
                    }}
                  />
                  <span
                    style={{
                      color: workflow.isActive
                        ? "var(--success)"
                        : "var(--text-muted)",
                    }}
                  >
                    {workflow.isActive ? "Active" : "Inactive"}
                  </span>
                </span>
                <span
                  style={{
                    width: "1px",
                    height: "12px",
                    background: "var(--border-color)",
                    display: "inline-block",
                  }}
                />
                <span
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Created {new Date(workflow.createdAt).toLocaleDateString()}
                </span>
                <span
                  style={{
                    width: "1px",
                    height: "12px",
                    background: "var(--border-color)",
                    display: "inline-block",
                  }}
                />
                <span
                  style={{ fontSize: "12px", color: "var(--text-secondary)" }}
                >
                  Starting step:{" "}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {workflow.initialState}
                  </strong>
                </span>
              </div>
            </div>
          </div>

          {/* Right: action buttons */}
          <div
            className="wfd-header-actions"
            style={{
              display: "flex",
              gap: "10px",
              alignItems: "center",
              flexShrink: 0,
              flexWrap: "wrap",
            }}
          >
            <Button
              variant="primary"
              onClick={() =>
                navigate(`/workflows/${toWorkflowSlug(workflow.name)}/records`)
              }
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              View Records
            </Button>
          </div>
        </div>

        {/* KPI strip */}
        <div
          className="wfd-kpi-strip"
          style={{
            display: "flex",
            gap: "12px",
            marginTop: "20px",
            flexWrap: "wrap",
          }}
        >
          <KpiChip
            label="Steps"
            value={workflow.states.length}
            accent="var(--accent-primary)"
          />
          <KpiChip
            label="Actions"
            value={workflow.transitions.length}
            accent="hsl(185,80%,40%)"
          />
          <KpiChip
            label="Details to Collect"
            value={fieldsLoading ? "…" : fields.length}
            accent="hsl(265,84%,60%)"
          />
          <KpiChip
            label="Steps with Deadlines"
            value={slaStates}
            accent="hsl(35,90%,50%)"
          />
        </div>
      </div>

      {/* ── Horizontal Tab Bar ─────────────────────────────── */}
      <div
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderBottom: "none",
          borderTopLeftRadius: "8px",
          borderTopRightRadius: "8px",
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          display: "flex",
          gap: "0",
          marginBottom: "0",
          overflowX: "auto",
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              padding: "12px 20px",
              fontSize: "13px",
              fontWeight: activeTab === tab.id ? 700 : 500,
              color:
                activeTab === tab.id
                  ? "var(--accent-primary)"
                  : "var(--text-secondary)",
              background: "none",
              border: "none",
              borderBottom:
                activeTab === tab.id
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              transition: "color 0.15s, border-color 0.15s",
            }}
          >
            {tab.label}
            {"count" in tab && tab.count !== undefined && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  background:
                    activeTab === tab.id
                      ? "hsla(250,84%,60%,.15)"
                      : "var(--bg-tertiary)",
                  color:
                    activeTab === tab.id
                      ? "var(--accent-primary)"
                      : "var(--text-muted)",
                  borderRadius: "20px",
                  padding: "1px 7px",
                  minWidth: "20px",
                  textAlign: "center",
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {inlineError && (
        <div
          className="alert alert-error"
          style={{
            marginBottom: "20px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>⚠ {inlineError}</span>
          <button
            onClick={() => setInlineError(null)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "16px",
              color: "inherit",
              padding: "0 4px",
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* ── Canvas Tab ─────────────────────────────────────── */}
      {activeTab === "canvas" && (
        <div
          className="data-panel"
          style={{
            borderTop: "none",
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            marginBottom: "20px",
          }}
        >
          {workflow.states.length > 20 || workflow.transitions.length > 40 ? (
            <>
              <div
                className="alert"
                style={{
                  marginBottom: "14px",
                  fontSize: "12px",
                  background: "hsla(38,92%,50%,.08)",
                  border: "1px solid hsla(38,92%,50%,.25)",
                  borderRadius: "8px",
                  padding: "10px 14px",
                  color: "var(--warning)",
                  fontWeight: 500,
                }}
              >
                Canvas view is disabled for workflows with more than 20 steps or
                40 actions. Using pipeline view.
              </div>
              <SectionHeader label="Step Pipeline" />
              <StateFlowDiagram
                states={workflow.states}
                transitions={workflow.transitions}
                initialState={workflow.initialState}
                workflowId={id}
                onStateUpdated={() => void refetch()}
              />
            </>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "14px",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.8px",
                  }}
                >
                  {canvasView === "canvas"
                    ? "Workflow Canvas"
                    : "Step Pipeline"}
                </span>
                <div
                  style={{
                    display: "flex",
                    gap: "2px",
                    background: "var(--bg-tertiary)",
                    borderRadius: "8px",
                    padding: "3px",
                    border: "1px solid var(--border-color)",
                  }}
                >
                  {(["canvas", "pipeline"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setCanvasView(v)}
                      style={{
                        padding: "3px 12px",
                        fontSize: "11px",
                        fontWeight: 600,
                        borderRadius: "6px",
                        border: "none",
                        cursor: "pointer",
                        background:
                          canvasView === v
                            ? "var(--accent-primary)"
                            : "transparent",
                        color:
                          canvasView === v ? "#fff" : "var(--text-secondary)",
                        transition: "background 0.15s",
                      }}
                    >
                      {v === "canvas" ? "Canvas" : "Pipeline"}
                    </button>
                  ))}
                </div>
              </div>
              {canvasView === "canvas" ? (
                <WorkflowCanvas
                  states={workflow.states}
                  transitions={workflow.transitions}
                  initialState={workflow.initialState}
                  workflowId={id ?? ""}
                  isAdmin={canManageWorkflow}
                  onSave={handleCanvasSave}
                  onDirtyChange={setCanvasDirty}
                />
              ) : (
                <StateFlowDiagram
                  states={workflow.states}
                  transitions={workflow.transitions}
                  initialState={workflow.initialState}
                  workflowId={id}
                  onStateUpdated={() => void refetch()}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* ── States Tab ─────────────────────────────────────── */}
      {activeTab === "states" && (
        <div
          className="data-panel"
          style={{
            borderTop: "none",
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            marginBottom: "20px",
          }}
        >
          <SectionHeader
            label="Steps"
            count={workflow.states.length}
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowAddState(true)}
              >
                + Add Step
              </Button>
            }
          />
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Type</th>
                  <th className="wfd-table-hide-xs">Deadline</th>
                  <th className="wfd-table-hide-xs">Order</th>
                  <th style={{ width: "80px" }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedStates.map((state) => (
                  <tr key={state.id}>
                    <td>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <StateDot color={state.color} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "13px" }}>
                            {state.label}
                          </div>
                          <code
                            className="code-inline"
                            style={{ fontSize: "11px" }}
                          >
                            {state.name}
                          </code>
                        </div>
                      </div>
                    </td>
                    <td>
                      {state.isTerminal ? (
                        <span className="badge badge-muted">Final</span>
                      ) : state.name === workflow.initialState ? (
                        <span className="badge badge-primary">
                          Starting Step
                        </span>
                      ) : (
                        <span className="badge badge-success">Active</span>
                      )}
                    </td>
                    <td
                      className="wfd-table-hide-xs"
                      style={{ fontSize: "13px" }}
                    >
                      {state.slaHours !== null ? (
                        <span
                          style={{ color: "var(--warning)", fontWeight: 600 }}
                        >
                          {state.slaHours}h
                        </span>
                      ) : (
                        <span className="text-muted-sm">—</span>
                      )}
                    </td>
                    <td
                      className="wfd-table-hide-xs"
                      style={{ fontSize: "13px", color: "var(--text-muted)" }}
                    >
                      {state.sortOrder}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          justifyContent: "flex-end",
                        }}
                      >
                        <IconButton
                          variant="edit"
                          onClick={() => {
                            setEditingState(state);
                            setStateForm({
                              name: state.name,
                              label: state.label,
                              color: state.color ?? "#6366f1",
                              isTerminal: state.isTerminal,
                              slaHours:
                                state.slaHours !== null
                                  ? String(state.slaHours)
                                  : "",
                              sortOrder: String(state.sortOrder),
                            });
                            setStateError(null);
                          }}
                          title="Edit step"
                        >
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </IconButton>
                        {state.name !== workflow.initialState ? (
                          <IconButton
                            variant="delete"
                            disabled={deletingStateId === state.id}
                            onClick={() =>
                              setConfirmDelete({
                                message: `Delete step "${state.label}"?`,
                                onConfirm: () => {
                                  setConfirmDelete(null);
                                  void handleDeleteState(state.id);
                                },
                              })
                            }
                            title="Delete step"
                          >
                            {deletingStateId === state.id ? (
                              <span style={{ fontSize: "11px" }}>…</span>
                            ) : (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                              </svg>
                            )}
                          </IconButton>
                        ) : (
                          <span
                            style={{ display: "inline-block", width: "30px" }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Transitions Tab ────────────────────────────────── */}
      {activeTab === "transitions" && (
        <div
          className="data-panel"
          style={{
            borderTop: "none",
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            marginBottom: "20px",
          }}
        >
          <SectionHeader
            label="Actions"
            count={workflow.transitions.length}
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowAddTransition(true)}
              >
                + Add Action
              </Button>
            }
          />
          {workflow.transitions.length === 0 ? (
            <div
              className="empty-state-inline"
              style={{ padding: "28px", fontSize: "13px" }}
            >
              No actions yet. Add actions to define how tickets move between
              steps.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Route</th>
                    <th className="wfd-table-hide-xs">Label</th>
                    <th className="wfd-table-hide-xs">Who Can Do This</th>
                    <th className="wfd-table-hide-xs">Requirements</th>
                    <th style={{ width: "80px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {workflow.transitions.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            flexWrap: "wrap",
                          }}
                        >
                          <code
                            className="code-inline"
                            style={{ fontSize: "11px" }}
                          >
                            {t.fromState}
                          </code>
                          <span
                            style={{
                              color: "var(--accent-primary)",
                              fontWeight: 700,
                              fontSize: "14px",
                            }}
                          >
                            →
                          </span>
                          <code
                            className="code-inline"
                            style={{ fontSize: "11px" }}
                          >
                            {t.toState}
                          </code>
                        </div>
                      </td>
                      <td
                        className="wfd-table-hide-xs"
                        style={{ fontWeight: 500, fontSize: "13px" }}
                      >
                        {t.label || <span className="text-muted-sm">—</span>}
                      </td>
                      <td className="wfd-table-hide-xs">
                        {t.allowedRoles.length === 0 ? (
                          <span className="text-muted-sm">Any</span>
                        ) : (
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              flexWrap: "wrap",
                            }}
                          >
                            {t.allowedRoles.map((r) => (
                              <span key={r} className="badge badge-primary">
                                {r}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="wfd-table-hide-xs">
                        {!t.requiresComment && t.requiresFields.length === 0 ? (
                          <span className="text-muted-sm">—</span>
                        ) : (
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              flexWrap: "wrap",
                            }}
                          >
                            {t.requiresComment && (
                              <span className="badge badge-warning">
                                Comment
                              </span>
                            )}
                            {t.requiresFields.length > 0 && (
                              <span className="badge badge-warning">
                                {t.requiresFields.length} detail
                                {t.requiresFields.length > 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <div
                          style={{
                            display: "flex",
                            gap: "6px",
                            justifyContent: "flex-end",
                          }}
                        >
                          <IconButton
                            variant="edit"
                            onClick={() => {
                              setEditingTransition(t);
                              setTransForm({
                                fromState: t.fromState,
                                toState: t.toState,
                                label: t.label,
                                allowedRoles: [...t.allowedRoles],
                                requiresComment: t.requiresComment,
                              });
                              setTransError(null);
                            }}
                            title="Edit action"
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </IconButton>
                          <IconButton
                            variant="delete"
                            disabled={deletingTransId === t.id}
                            onClick={() =>
                              setConfirmDelete({
                                message: `Delete action "${t.label || `${t.fromState} → ${t.toState}`}"?`,
                                onConfirm: () => {
                                  setConfirmDelete(null);
                                  void handleDeleteTransition(t.id);
                                },
                              })
                            }
                            title="Delete action"
                          >
                            {deletingTransId === t.id ? (
                              <span style={{ fontSize: "11px" }}>…</span>
                            ) : (
                              <svg
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                              </svg>
                            )}
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Fields Tab ─────────────────────────────────────── */}
      {activeTab === "fields" && (
        <div
          className="data-panel"
          style={{
            borderTop: "none",
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            marginBottom: "20px",
          }}
        >
          <SectionHeader
            label="Details to Collect"
            count={fields.length}
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowAddField(true)}
              >
                + Add Detail
              </Button>
            }
          />
          {fieldsLoading ? (
            <div style={{ padding: "20px", textAlign: "center" }}>
              <div className="spinner" style={{ margin: "0 auto" }} />
            </div>
          ) : fields.length === 0 ? (
            <div
              className="empty-state-inline"
              style={{ padding: "28px", fontSize: "13px" }}
            >
              No details yet. Add details to capture information on tickets.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: "28px" }}></th>
                    <th>Detail</th>
                    <th className="wfd-table-hide-xs">Type</th>
                    <th className="wfd-table-hide-xs">Required</th>
                    <th style={{ width: "80px" }}></th>
                  </tr>
                </thead>
                <DndContext
                  sensors={fieldSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={(e) => void handleFieldDragEnd(e)}
                >
                  <SortableContext
                    items={[...fields]
                      .sort((a, b) => a.sortOrder - b.sortOrder)
                      .map((f) => f.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <tbody>
                      {[...fields]
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((f) => (
                          <SortableFieldRow
                            key={f.id}
                            field={f}
                            dragDisabled={!canManageWorkflow}
                          >
                            <td>
                              <div>
                                <div
                                  style={{ fontWeight: 600, fontSize: "13px" }}
                                >
                                  {f.label}
                                </div>
                                <code
                                  className="code-inline"
                                  style={{ fontSize: "11px" }}
                                >
                                  {f.name}
                                </code>
                              </div>
                            </td>
                            <td className="wfd-table-hide-xs">
                              <span className="badge badge-muted">
                                {f.fieldType}
                              </span>
                            </td>
                            <td className="wfd-table-hide-xs">
                              {f.isRequired ? (
                                <span className="badge badge-primary">Yes</span>
                              ) : (
                                <span className="text-muted-sm">—</span>
                              )}
                            </td>
                            <td
                              style={{
                                textAlign: "right",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  gap: "6px",
                                  justifyContent: "flex-end",
                                }}
                              >
                                <IconButton
                                  variant="edit"
                                  onClick={() => {
                                    setEditingField(f);
                                    setFieldForm({
                                      name: f.name,
                                      label: f.label,
                                      fieldType: f.fieldType,
                                      isRequired: f.isRequired,
                                    });
                                    setFieldError(null);
                                  }}
                                  title="Edit detail"
                                >
                                  <svg
                                    width="13"
                                    height="13"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                                  </svg>
                                </IconButton>
                                <IconButton
                                  variant="delete"
                                  disabled={deletingFieldId === f.id}
                                  onClick={() =>
                                    setConfirmDelete({
                                      message: `Delete detail "${f.label}"?`,
                                      onConfirm: () => {
                                        setConfirmDelete(null);
                                        void handleDeleteField(f.id);
                                      },
                                    })
                                  }
                                  title="Delete detail"
                                >
                                  {deletingFieldId === f.id ? (
                                    <span style={{ fontSize: "11px" }}>…</span>
                                  ) : (
                                    <svg
                                      width="13"
                                      height="13"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    >
                                      <polyline points="3 6 5 6 21 6" />
                                      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                                      <path d="M10 11v6M14 11v6" />
                                    </svg>
                                  )}
                                </IconButton>
                              </div>
                            </td>
                          </SortableFieldRow>
                        ))}
                    </tbody>
                  </SortableContext>
                </DndContext>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Settings Tab ───────────────────────────────────── */}
      {activeTab === "settings" && (
        <div
          style={{
            background: "var(--bg-secondary)",
            border: "1px solid var(--border-color)",
            borderTop: "none",
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            borderBottomLeftRadius: "8px",
            borderBottomRightRadius: "8px",
            padding: "24px",
            marginBottom: "20px",
          }}
        >
          {/* Admin assignment — full width, above the two-column grid */}
          <div
            className="data-panel wfd-settings-panel"
            style={{ marginBottom: "20px" }}
          >
            <SectionHeader label="Workflow Admins" />
            <p
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                marginBottom: "14px",
                lineHeight: 1.5,
              }}
            >
              Admins have full access over this workflow — they can manage
              steps, actions, and details to collect.
              {!isAdminListEditor &&
                " Only the creator or a global admin can add or remove admins."}
            </p>

            {/* Admin pills */}
            {assignedTo.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px",
                  marginBottom: "14px",
                }}
              >
                {assignedTo.map((userId) => {
                  const u = orgUsers.find((o) => o.userId === userId);
                  // `displayName`/`userId` are expected to be strings, but
                  // user data can be malformed upstream (missing profile
                  // fields) — coerce so a bad row can't blank the whole page.
                  const displayName = String(u?.displayName ?? userId);
                  const initials = displayName
                    .split(" ")
                    .slice(0, 2)
                    .map((p) => p[0] ?? "")
                    .join("")
                    .toUpperCase();
                  const isCreator = userId === workflow.createdBy;
                  // Creator is only removable by a global admin (never by
                  // themselves, never by a fellow non-creator admin).
                  const canRemove =
                    isAdminListEditor && !(isCreator && !isAdmin);

                  return (
                    <div
                      key={userId}
                      title={u?.email ?? u?.loginName ?? userId}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "6px 8px 6px 6px",
                        background: "var(--bg-tertiary)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "999px",
                        maxWidth: "100%",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "24px",
                          height: "24px",
                          borderRadius: "50%",
                          background: "var(--accent-primary)",
                          color: "#fff",
                          fontSize: "10px",
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {initials}
                      </span>
                      <span
                        style={{
                          fontSize: "13px",
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "160px",
                        }}
                      >
                        {displayName}
                      </span>
                      <span
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: isCreator
                            ? "var(--text-secondary)"
                            : "var(--accent-primary)",
                          background: isCreator
                            ? "var(--bg-secondary)"
                            : "hsla(250,84%,60%,.1)",
                          border: isCreator
                            ? "1px solid var(--border-color)"
                            : "1px solid hsla(250,84%,60%,.2)",
                          borderRadius: "999px",
                          padding: "2px 8px",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        {isCreator ? "Creator" : "Admin"}
                      </span>
                      {canRemove && (
                        <button
                          type="button"
                          disabled={savingAssign}
                          onClick={() =>
                            void handleAssign(
                              assignedTo.filter((id) => id !== userId),
                            )
                          }
                          title={
                            isCreator
                              ? "Remove creator (global admin only)"
                              : "Remove admin"
                          }
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "20px",
                            height: "20px",
                            borderRadius: "50%",
                            background: "none",
                            border: "none",
                            cursor: savingAssign ? "not-allowed" : "pointer",
                            color: "var(--text-muted)",
                            flexShrink: 0,
                            opacity: savingAssign ? 0.5 : 1,
                            transition: "background 0.12s, color 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.background = "hsla(0,84%,60%,.12)";
                            (e.currentTarget as HTMLButtonElement).style.color =
                              "var(--danger)";
                          }}
                          onMouseLeave={(e) => {
                            (
                              e.currentTarget as HTMLButtonElement
                            ).style.background = "none";
                            (e.currentTarget as HTMLButtonElement).style.color =
                              "var(--text-muted)";
                          }}
                        >
                          <svg
                            width="11"
                            height="11"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                          >
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {isAdminListEditor && (
              <>
                <MultiUserPicker
                  users={orgUsers}
                  value={assignedTo}
                  onChange={(uids) => void handleAssign(uids)}
                  placeholder="Add workflow admins…"
                  disabled={savingAssign}
                />
                {savingAssign && (
                  <p
                    style={{
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      marginTop: "8px",
                    }}
                  >
                    Saving…
                  </p>
                )}
              </>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "20px",
              alignItems: "start",
            }}
            className="wfd-settings-grid"
          >
            {/* Left: workflow details + state colors */}
            <div
              style={{ display: "flex", flexDirection: "column", gap: "20px" }}
            >
              <div className="data-panel wfd-settings-panel">
                <SectionHeader label="Workflow Details" />
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                  }}
                >
                  {[
                    { label: "Workflow ID", value: id ?? "" },
                    { label: "Starting Step", value: workflow.initialState },
                    {
                      label: "Final Steps",
                      value:
                        workflow.states
                          .filter((s) => s.isTerminal)
                          .map((s) => s.label)
                          .join(", ") || "None",
                    },
                    {
                      label: "Steps with Deadlines",
                      value:
                        slaStates > 0
                          ? `${slaStates} of ${workflow.states.length} steps`
                          : "No deadlines set",
                    },
                    {
                      label: "Status",
                      value: workflow.isActive ? "Active" : "Inactive",
                    },
                    {
                      label: "Created",
                      value: new Date(workflow.createdAt).toLocaleDateString(
                        undefined,
                        { year: "numeric", month: "long", day: "numeric" },
                      ),
                    },
                  ].map((row) => (
                    <div key={row.label}>
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: "var(--text-muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          marginBottom: "3px",
                        }}
                      >
                        {row.label}
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          fontWeight: 500,
                          color: "var(--text-primary)",
                          wordBreak: "break-all",
                          fontFamily:
                            row.label === "Workflow ID"
                              ? "var(--font-mono, monospace)"
                              : undefined,
                        }}
                      >
                        {row.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* State color legend */}
              {workflow.states.length > 0 && (
                <div className="data-panel wfd-settings-panel">
                  <SectionHeader label="Step Colors" />
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                    }}
                  >
                    {sortedStates.map((s) => (
                      <div
                        key={s.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          padding: "8px 12px",
                          borderRadius: "var(--radius-sm)",
                          background: "var(--bg-tertiary)",
                        }}
                      >
                        <span
                          style={{
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            background: s.color ?? "var(--accent-primary)",
                            flexShrink: 0,
                            boxShadow: `0 0 0 2px ${s.color ?? "var(--accent-primary)"}33`,
                          }}
                        />
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: 500,
                            color: "var(--text-primary)",
                            flex: 1,
                          }}
                        >
                          {s.label}
                        </span>
                        <code
                          className="code-inline"
                          style={{ fontSize: "10px" }}
                        >
                          {s.color ?? "—"}
                        </code>
                        {s.name === workflow.initialState && (
                          <span
                            style={{
                              fontSize: "9px",
                              fontWeight: 700,
                              color: "var(--accent-primary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.4px",
                            }}
                          >
                            start
                          </span>
                        )}
                        {s.isTerminal && (
                          <span
                            style={{
                              fontSize: "9px",
                              fontWeight: 700,
                              color: "var(--text-muted)",
                              textTransform: "uppercase",
                              letterSpacing: "0.4px",
                            }}
                          >
                            end
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right: admin assignment + danger zone */}
            <div
              style={{ display: "flex", flexDirection: "column", gap: "20px" }}
            >
              {/* Child ticket limits */}
              <div className="data-panel wfd-settings-panel">
                <SectionHeader label="Sub-task Limits" />
                <p
                  style={{
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                    marginBottom: "14px",
                    lineHeight: 1.5,
                  }}
                >
                  Control how deeply tickets can be nested and how many
                  sub-tasks a single ticket can have.
                </p>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                    marginBottom: "14px",
                  }}
                >
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        marginBottom: "5px",
                      }}
                    >
                      Max nesting depth
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      className="portal-input"
                      style={{ width: "120px" }}
                      value={maxChildDepth}
                      onChange={(e) => setMaxChildDepth(e.target.value)}
                      placeholder="1"
                    />
                    <p
                      style={{
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        marginTop: "4px",
                      }}
                    >
                      How many levels deep sub-tasks can go (default: 1)
                    </p>
                  </div>
                  <div>
                    <label
                      style={{
                        display: "block",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        marginBottom: "5px",
                      }}
                    >
                      Max sub-tasks per ticket
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={200}
                      className="portal-input"
                      style={{ width: "120px" }}
                      value={maxChildrenPerParent}
                      onChange={(e) => setMaxChildrenPerParent(e.target.value)}
                      placeholder="10"
                    />
                    <p
                      style={{
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        marginTop: "4px",
                      }}
                    >
                      Maximum number of direct sub-tasks (default: 10)
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  disabled={savingChildSettings}
                  onClick={() => void handleSaveChildSettings()}
                  style={{ minWidth: "110px" }}
                >
                  {savingChildSettings ? "Saving…" : "Save limits"}
                </Button>
              </div>

              {/* Activate / Deactivate */}
              <div className="data-panel wfd-settings-panel">
                <SectionHeader label="Workflow Status" />
                <p
                  style={{
                    fontSize: "13px",
                    color: "var(--text-secondary)",
                    marginBottom: "14px",
                    lineHeight: 1.5,
                  }}
                >
                  {workflow.isActive
                    ? "This workflow is currently active. Deactivating it will prevent new records from being created."
                    : "This workflow is inactive. Activate it to allow new records to be created."}
                </p>
                <Button
                  variant={workflow.isActive ? "secondary" : "primary"}
                  onClick={() => void handleToggleActive()}
                  disabled={togglingActive}
                  style={{ minWidth: "130px" }}
                >
                  {togglingActive
                    ? "Saving…"
                    : workflow.isActive
                      ? "Deactivate Workflow"
                      : "Activate Workflow"}
                </Button>
              </div>

              {/* Danger zone — deletion is restricted to the creator or a
                  global admin (matches the backend's deleteWorkflow gate) */}
              {isAdminListEditor && (
                <div
                  className="data-panel wfd-settings-panel"
                  style={{
                    borderTop: "3px solid var(--danger)",
                    background: "hsla(0,84%,60%,.03)",
                  }}
                >
                  <SectionHeader label="Danger Zone" />
                  <p
                    style={{
                      fontSize: "13px",
                      color: "var(--text-secondary)",
                      marginBottom: "14px",
                      lineHeight: 1.5,
                    }}
                  >
                    Permanently delete this workflow and all its states and
                    transitions. This cannot be undone.
                  </p>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setShowDeleteWorkflow(true)}
                  >
                    Delete Workflow
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────── */}

      {/* Add Field */}
      {showAddField && (
        <div className="modal-overlay" onClick={() => setShowAddField(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add Detail</h3>
              <button
                className="modal-close"
                onClick={() => setShowAddField(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(e) => void handleAddField(e)}>
              <div className="modal-body">
                {fieldError && (
                  <div
                    className="alert alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {fieldError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Label *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Customer Name"
                      value={fieldForm.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        const name = label
                          .toLowerCase()
                          .replace(/\s+/g, "_")
                          .replace(/[^a-z0-9_]/g, "");
                        setFieldForm((f) => ({ ...f, label, name }));
                      }}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Detail ID *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. customer_name"
                      value={fieldForm.name}
                      onChange={(e) =>
                        setFieldForm((f) => ({ ...f, name: e.target.value }))
                      }
                      pattern="^[a-z_][a-z0-9_]*$"
                      title="snake_case only"
                      required
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Detail Type *</label>
                  <select
                    className="form-input"
                    value={fieldForm.fieldType}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        fieldType: e.target.value,
                      }))
                    }
                  >
                    {FIELD_TYPES.map((ft) => (
                      <option key={ft.value} value={ft.value}>
                        {ft.label}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={fieldForm.isRequired}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        isRequired: e.target.checked,
                      }))
                    }
                  />
                  <span>Required field</span>
                </label>
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowAddField(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={savingField}>
                  {savingField ? "Adding…" : "Add Detail"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add State */}
      {showAddState && (
        <div className="modal-overlay" onClick={() => setShowAddState(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add Step</h3>
              <button
                className="modal-close"
                onClick={() => setShowAddState(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(e) => void handleAddState(e)}>
              <div className="modal-body">
                {stateError && (
                  <div
                    className="alert alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {stateError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Label *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. In Progress"
                      value={stateForm.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        const name = label
                          .toLowerCase()
                          .replace(/\s+/g, "_")
                          .replace(/[^a-z0-9_]/g, "");
                        setStateForm((f) => ({ ...f, label, name }));
                      }}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Step ID *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. in_progress"
                      value={stateForm.name}
                      onChange={(e) =>
                        setStateForm((f) => ({ ...f, name: e.target.value }))
                      }
                      pattern="^[a-z_][a-z0-9_]*$"
                      title="snake_case only"
                      required
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Color</label>
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                      }}
                    >
                      <input
                        type="color"
                        value={stateForm.color}
                        onChange={(e) =>
                          setStateForm((f) => ({
                            ...f,
                            color: e.target.value,
                          }))
                        }
                        style={{
                          width: "40px",
                          height: "36px",
                          border: "none",
                          borderRadius: "6px",
                          cursor: "pointer",
                        }}
                      />
                      <input
                        className="form-input"
                        value={stateForm.color}
                        onChange={(e) =>
                          setStateForm((f) => ({
                            ...f,
                            color: e.target.value,
                          }))
                        }
                        placeholder="#6366f1"
                        style={{ flex: 1 }}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Order</label>
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      value={stateForm.sortOrder}
                      onChange={(e) =>
                        setStateForm((f) => ({
                          ...f,
                          sortOrder: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Deadline (hours, optional)
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    placeholder="e.g. 24"
                    value={stateForm.slaHours}
                    onChange={(e) =>
                      setStateForm((f) => ({
                        ...f,
                        slaHours: e.target.value,
                      }))
                    }
                  />
                </div>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={stateForm.isTerminal}
                    onChange={(e) =>
                      setStateForm((f) => ({
                        ...f,
                        isTerminal: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    This is a final step
                    <br />
                    <span
                      style={{ fontWeight: 400, color: "var(--text-muted)" }}
                    >
                      Tickets won&apos;t move further once they reach this step
                    </span>
                  </span>
                </label>
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowAddState(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={savingState}>
                  {savingState ? "Adding…" : "Add Step"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Transition */}
      {showAddTransition && (
        <div
          className="modal-overlay"
          onClick={() => setShowAddTransition(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add Action</h3>
              <button
                className="modal-close"
                onClick={() => setShowAddTransition(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(e) => void handleAddTransition(e)}>
              <div className="modal-body">
                {transError && (
                  <div
                    className="alert alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {transError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">From Step *</label>
                    <select
                      className="form-input"
                      value={transForm.fromState}
                      onChange={(e) =>
                        setTransForm((f) => ({
                          ...f,
                          fromState: e.target.value,
                        }))
                      }
                      required
                    >
                      <option value="">Select…</option>
                      {stateNames.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">To Step *</label>
                    <select
                      className="form-input"
                      value={transForm.toState}
                      onChange={(e) =>
                        setTransForm((f) => ({
                          ...f,
                          toState: e.target.value,
                        }))
                      }
                      required
                    >
                      <option value="">Select…</option>
                      {stateNames.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Label</label>
                  <input
                    className="form-input"
                    placeholder="e.g. Start Work"
                    value={transForm.label}
                    onChange={(e) =>
                      setTransForm((f) => ({ ...f, label: e.target.value }))
                    }
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Who Can Do This (blank = anyone)
                  </label>
                  {availableRoles.length === 0 ? (
                    <p style={{ fontSize: "13px", color: "#6b7280" }}>
                      Loading roles…
                    </p>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        maxHeight: "160px",
                        overflowY: "auto",
                        border: "1px solid #e5e7eb",
                        borderRadius: "6px",
                        padding: "8px",
                      }}
                    >
                      {availableRoles.map((role) => (
                        <label
                          key={role}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            fontSize: "14px",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={transForm.allowedRoles.includes(role)}
                            onChange={(e) =>
                              setTransForm((f) => ({
                                ...f,
                                allowedRoles: e.target.checked
                                  ? [...f.allowedRoles, role]
                                  : f.allowedRoles.filter((r) => r !== role),
                              }))
                            }
                          />
                          {role}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={transForm.requiresComment}
                    onChange={(e) =>
                      setTransForm((f) => ({
                        ...f,
                        requiresComment: e.target.checked,
                      }))
                    }
                  />
                  <span>Requires comment</span>
                </label>
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setShowAddTransition(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={savingTrans}>
                  {savingTrans ? "Adding…" : "Add Action"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Field */}
      {editingField && (
        <div className="modal-overlay" onClick={() => setEditingField(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                Edit Detail — {editingField.label}
              </h3>
              <button
                className="modal-close"
                onClick={() => setEditingField(null)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(e) => void handleEditField(e)}>
              <div className="modal-body">
                {fieldError && (
                  <div
                    className="alert alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {fieldError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Label *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. Customer Name"
                      value={fieldForm.label}
                      onChange={(e) =>
                        setFieldForm((f) => ({ ...f, label: e.target.value }))
                      }
                      required
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      Detail ID (cannot be changed)
                    </label>
                    <input
                      className="form-input"
                      value={fieldForm.name}
                      disabled
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Detail Type (cannot be changed)
                  </label>
                  <input
                    className="form-input"
                    value={
                      FIELD_TYPES.find((ft) => ft.value === fieldForm.fieldType)
                        ?.label ?? fieldForm.fieldType
                    }
                    disabled
                  />
                </div>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={fieldForm.isRequired}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        isRequired: e.target.checked,
                      }))
                    }
                  />
                  <span>Required field</span>
                </label>
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditingField(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={savingField}>
                  {savingField ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit State */}
      {editingState && (
        <div className="modal-overlay" onClick={() => setEditingState(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Edit Step — {editingState.label}</h3>
              <button
                className="modal-close"
                onClick={() => setEditingState(null)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(e) => void handleEditState(e)}>
              <div className="modal-body">
                {stateError && (
                  <div
                    className="alert alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {stateError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Label *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. In Progress"
                      value={stateForm.label}
                      onChange={(e) => {
                        const label = e.target.value;
                        const name = label
                          .toLowerCase()
                          .replace(/\s+/g, "_")
                          .replace(/[^a-z0-9_]/g, "");
                        setStateForm((f) => ({ ...f, label, name }));
                      }}
                      required
                      autoFocus
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Step ID *</label>
                    <input
                      className="form-input"
                      placeholder="e.g. in_progress"
                      value={stateForm.name}
                      onChange={(e) =>
                        setStateForm((f) => ({ ...f, name: e.target.value }))
                      }
                      pattern="^[a-z_][a-z0-9_]*$"
                      title="snake_case only"
                      required
                    />
                    <span
                      style={{
                        fontSize: "12px",
                        color: "var(--text-secondary, #6b7280)",
                      }}
                    >
                      Used to connect Actions to this step — changing it updates
                      any Actions that already point here.
                    </span>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Color</label>
                    <div
                      style={{
                        display: "flex",
                        gap: "8px",
                        alignItems: "center",
                      }}
                    >
                      <input
                        type="color"
                        value={stateForm.color}
                        onChange={(e) =>
                          setStateForm((f) => ({
                            ...f,
                            color: e.target.value,
                          }))
                        }
                        style={{
                          width: "40px",
                          height: "36px",
                          border: "none",
                          borderRadius: "6px",
                          cursor: "pointer",
                        }}
                      />
                      <input
                        className="form-input"
                        value={stateForm.color}
                        onChange={(e) =>
                          setStateForm((f) => ({
                            ...f,
                            color: e.target.value,
                          }))
                        }
                        placeholder="#6366f1"
                        style={{ flex: 1 }}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Order</label>
                    <input
                      className="form-input"
                      type="number"
                      min={0}
                      value={stateForm.sortOrder}
                      onChange={(e) =>
                        setStateForm((f) => ({
                          ...f,
                          sortOrder: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Deadline (hours, optional)
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    placeholder="e.g. 24"
                    value={stateForm.slaHours}
                    onChange={(e) =>
                      setStateForm((f) => ({
                        ...f,
                        slaHours: e.target.value,
                      }))
                    }
                  />
                </div>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={stateForm.isTerminal}
                    onChange={(e) =>
                      setStateForm((f) => ({
                        ...f,
                        isTerminal: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    This is a final step
                    <br />
                    <span
                      style={{ fontWeight: 400, color: "var(--text-muted)" }}
                    >
                      Tickets won&apos;t move further once they reach this step
                    </span>
                  </span>
                </label>
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditingState(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={savingState}>
                  {savingState ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Transition */}
      {editingTransition && (
        <div
          className="modal-overlay"
          onClick={() => setEditingTransition(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Edit Action</h3>
              <button
                className="modal-close"
                onClick={() => setEditingTransition(null)}
              >
                ×
              </button>
            </div>
            <form onSubmit={(e) => void handleEditTransition(e)}>
              <div className="modal-body">
                {transError && (
                  <div
                    className="alert alert-error"
                    style={{ marginBottom: "16px" }}
                  >
                    {transError}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">
                      From Step (cannot be changed)
                    </label>
                    <input
                      className="form-input"
                      value={transForm.fromState}
                      disabled
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">
                      To Step (cannot be changed)
                    </label>
                    <input
                      className="form-input"
                      value={transForm.toState}
                      disabled
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Label</label>
                  <input
                    className="form-input"
                    placeholder="e.g. Start Work"
                    value={transForm.label}
                    onChange={(e) =>
                      setTransForm((f) => ({ ...f, label: e.target.value }))
                    }
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Who Can Do This (blank = anyone)
                  </label>
                  {availableRoles.length === 0 ? (
                    <p style={{ fontSize: "13px", color: "#6b7280" }}>
                      Loading roles…
                    </p>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "6px",
                        maxHeight: "160px",
                        overflowY: "auto",
                        border: "1px solid #e5e7eb",
                        borderRadius: "6px",
                        padding: "8px",
                      }}
                    >
                      {availableRoles.map((role) => (
                        <label
                          key={role}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            fontSize: "14px",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={transForm.allowedRoles.includes(role)}
                            onChange={(e) =>
                              setTransForm((f) => ({
                                ...f,
                                allowedRoles: e.target.checked
                                  ? [...f.allowedRoles, role]
                                  : f.allowedRoles.filter((r) => r !== role),
                              }))
                            }
                          />
                          {role}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={transForm.requiresComment}
                    onChange={(e) =>
                      setTransForm((f) => ({
                        ...f,
                        requiresComment: e.target.checked,
                      }))
                    }
                  />
                  <span>Requires comment</span>
                </label>
              </div>
              <div className="modal-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setEditingTransition(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={savingTrans}>
                  {savingTrans ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Shared confirm-delete */}
      <ConfirmDeleteDialog
        open={confirmDelete !== null}
        message={confirmDelete?.message ?? ""}
        onConfirm={() => confirmDelete?.onConfirm()}
        onCancel={() => setConfirmDelete(null)}
        busy={
          deletingFieldId !== null ||
          deletingStateId !== null ||
          deletingTransId !== null
        }
      />

      {/* Delete workflow */}
      <ConfirmDeleteDialog
        open={showDeleteWorkflow}
        title="Delete workflow?"
        message={
          <>
            You are about to permanently delete{" "}
            <strong>"{workflow.name}"</strong>. This will also remove all its
            steps and actions.
          </>
        }
        errorMessage={deleteWorkflowError}
        confirmLabel="Delete Workflow"
        busy={deletingWorkflow}
        onConfirm={() => void handleDeleteWorkflow()}
        onCancel={() => setShowDeleteWorkflow(false)}
      />

      {/* Nav-away guard — unsaved canvas changes */}
      {blocker.state === "blocked" && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "var(--bg-card, #fff)",
              border: "1px solid var(--border-color, #e5e7eb)",
              borderRadius: "12px",
              padding: "24px 26px",
              width: "360px",
              boxShadow: "0 8px 32px rgba(0,0,0,.16)",
            }}
          >
            <div
              style={{
                fontSize: "14px",
                fontWeight: 700,
                marginBottom: "8px",
                color: "var(--text-primary)",
              }}
            >
              Unsaved canvas changes
            </div>
            <div
              style={{
                fontSize: "13px",
                color: "var(--text-secondary)",
                marginBottom: "20px",
              }}
            >
              You have unsaved canvas changes. Leave without saving?
            </div>
            <div style={{ display: "flex", gap: "10px" }}>
              <Button variant="primary" onClick={() => blocker.proceed()}>
                Leave without saving
              </Button>
              <Button variant="secondary" onClick={() => blocker.reset()}>
                Stay
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
