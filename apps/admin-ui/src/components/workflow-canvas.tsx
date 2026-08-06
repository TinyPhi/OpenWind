import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  Handle,
  MiniMap,
  Position,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Connection,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Dialog, DialogContent, DialogTitle } from "@platform/ui";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkflowState = {
  id: string;
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
  slaHours: number | null;
  sortOrder: number;
};

export type WorkflowTransition = {
  id: string;
  fromState: string;
  toState: string;
  label: string;
  allowedRoles: string[];
  requiresComment: boolean;
  requiresFields: string[];
};

export type CanvasDraft = {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
};

type CanvasProps = {
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  initialState: string;
  workflowId: string;
  isAdmin: boolean;
  onSave?: (draft: CanvasDraft) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

type StateNodeData = {
  state: WorkflowState;
  isInitial: boolean;
  isAdmin: boolean;
  onDoubleClick: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const NODE_W = 160;
const NODE_H = 72;
const NEW_PREFIX = "__new_";

// ── localStorage helpers ─────────────────────────────────────────────────────

function posKey(workflowId: string): string {
  return `wf-canvas-positions-${workflowId}`;
}

function savePositions(workflowId: string, nodes: Node<StateNodeData>[]): void {
  const map: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) map[n.id] = n.position;
  localStorage.setItem(posKey(workflowId), JSON.stringify(map));
}

function loadPositions(
  workflowId: string,
): Record<string, { x: number; y: number }> | null {
  const raw = localStorage.getItem(posKey(workflowId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, { x: number; y: number }>;
  } catch {
    return null;
  }
}

// ── dagre layout ─────────────────────────────────────────────────────────────

function applyDagreLayout(
  nodes: Node<StateNodeData>[],
  edges: Edge[],
): Node<StateNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 70, ranksep: 100 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) {
    if (e.source !== e.target) g.setEdge(e.source, e.target);
  }

  dagre.layout(g as Parameters<typeof dagre.layout>[0]);

  return nodes.map((n) => {
    const pos = g.node(n.id) as { x: number; y: number } | undefined;
    const position: { x: number; y: number } = pos
      ? { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 }
      : n.position;
    return { ...n, position };
  });
}

// ── Custom state node ────────────────────────────────────────────────────────

function StateNode({ data }: NodeProps<StateNodeData>): React.ReactElement {
  const { state, isInitial, isAdmin, onDoubleClick, onContextMenu } = data;
  const accent = state.color ?? "#6366f1";

  return (
    <div
      onDoubleClick={() => onDoubleClick(state.id)}
      onContextMenu={(e) => {
        if (isAdmin) onContextMenu(e, state.id);
      }}
      style={{
        width: NODE_W,
        height: NODE_H,
        background: "var(--bg-card, #fff)",
        border: state.isTerminal
          ? `3px double ${accent}`
          : `1.5px solid ${accent}`,
        borderRadius: "10px",
        boxShadow: "0 1px 4px rgba(0,0,0,.08)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "8px 12px",
        position: "relative",
        fontSize: "12px",
        userSelect: "none",
        cursor: isAdmin ? "pointer" : "default",
      }}
    >
      {isInitial && (
        <span
          style={{
            position: "absolute",
            top: "-8px",
            left: "10px",
            fontSize: "9px",
            fontWeight: 700,
            color: accent,
            background: "var(--bg-card, #fff)",
            padding: "0 4px",
            letterSpacing: "0.4px",
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
            left: "10px",
            fontSize: "9px",
            fontWeight: 700,
            color: "var(--text-muted, #888)",
            background: "var(--bg-card, #fff)",
            padding: "0 4px",
            letterSpacing: "0.4px",
          }}
        >
          END
        </span>
      )}
      <div
        style={{
          fontWeight: 700,
          color: "var(--text-primary, #111)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {state.label}
      </div>
      <div
        style={{
          fontSize: "10px",
          color: "var(--text-muted, #888)",
          marginTop: "2px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {state.name}
      </div>
      {state.slaHours !== null && (
        <div
          style={{
            position: "absolute",
            top: "6px",
            right: "8px",
            fontSize: "9px",
            fontWeight: 700,
            color: "var(--warning, #f59e0b)",
            background: "hsla(38,92%,50%,.12)",
            borderRadius: "8px",
            padding: "1px 5px",
          }}
        >
          SLA {state.slaHours}h
        </div>
      )}
      {/* ReactFlow handles — visible in edit mode */}
      {(
        [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
      ).map((pos) => (
        <Handle
          key={pos}
          type="source"
          position={pos}
          style={{
            width: isAdmin ? 10 : 0,
            height: isAdmin ? 10 : 0,
            background: accent,
            border: "2px solid #fff",
            opacity: isAdmin ? 0.45 : 0,
            transition: "opacity 0.15s",
          }}
          className={isAdmin ? "canvas-handle" : ""}
        />
      ))}
    </div>
  );
}

// ── Custom labelled edge ──────────────────────────────────────────────────────

function LabelledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  source,
  target,
}: EdgeProps & {
  data?: { label: string };
  source: string;
  target: string;
}): React.ReactElement {
  const isSelfLoop = source === target;

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (isSelfLoop) {
    const r = 30;
    const cx = sourceX;
    const cy = sourceY - r * 2;
    edgePath = `M ${sourceX} ${sourceY} C ${cx - r} ${cy} ${cx + r} ${cy} ${sourceX} ${sourceY}`;
    labelX = cx;
    labelY = cy - 10;
  } else {
    [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  const label = (data as { label?: string } | undefined)?.label ?? "";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        {...(typeof markerEnd === "string" ? { markerEnd } : {})}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              fontSize: "10px",
              fontWeight: 600,
              color: "var(--accent-primary, #6366f1)",
              background: "var(--bg-primary, #fff)",
              padding: "1px 5px",
              borderRadius: "4px",
              border: "1px solid var(--border-color, #e5e7eb)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
              maxWidth: "120px",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            className="nodrag nopan"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── Node / edge type registrations ───────────────────────────────────────────

const NODE_TYPES = { stateNode: StateNode };
const EDGE_TYPES = { labelledEdge: LabelledEdge };

// ── RF node/edge builders ─────────────────────────────────────────────────────

function buildNodes(
  states: WorkflowState[],
  initialState: string,
  isAdmin: boolean,
  callbacks: Pick<StateNodeData, "onDoubleClick" | "onContextMenu">,
): Node<StateNodeData>[] {
  return states.map((s) => ({
    id: s.id,
    type: "stateNode",
    position: { x: 0, y: 0 },
    data: {
      state: s,
      isInitial: s.name === initialState,
      isAdmin,
      ...callbacks,
    },
    draggable: true,
  }));
}

function buildEdges(
  transitions: WorkflowTransition[],
  statesByName: Map<string, WorkflowState>,
): Edge[] {
  return transitions
    .map((t) => {
      const src = statesByName.get(t.fromState);
      const tgt = statesByName.get(t.toState);
      if (!src || !tgt) return null;
      return {
        id: t.id,
        source: src.id,
        target: tgt.id,
        type: "labelledEdge",
        data: { label: t.label },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: {
          stroke: "var(--accent-primary, #6366f1)",
          strokeWidth: 1.5,
          opacity: 0.75,
        },
      } satisfies Edge;
    })
    .filter(Boolean) as Edge[];
}

// ── Overlay components ────────────────────────────────────────────────────────

type AddStateForm = { name: string; label: string };

function AddStateDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (f: AddStateForm) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [form, setForm] = useState<AddStateForm>({ name: "", label: "" });
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    const name = form.name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "");
    if (!name || !form.label.trim()) return;
    onConfirm({ name, label: form.label.trim() });
  }

  return (
    <Dialog
      open={true}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent style={overlayCardStyle}>
        <DialogTitle asChild>
          <div style={overlayTitleStyle}>Add State</div>
        </DialogTitle>
        <form onSubmit={submit}>
          <label style={labelStyle}>Name (slug, auto-formatted)</label>
          <input
            ref={nameRef}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. in_review"
            style={inputStyle}
            required
          />
          <label style={labelStyle}>Display label</label>
          <input
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="e.g. In Review"
            style={inputStyle}
            required
          />
          <div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
            <button type="submit" style={btnPrimaryStyle}>
              Add
            </button>
            <button type="button" onClick={onCancel} style={btnSecondaryStyle}>
              Cancel
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type EditStateForm = {
  label: string;
  color: string;
  isTerminal: boolean;
  slaHours: string;
};

function EditStateDialog({
  state,
  onConfirm,
  onCancel,
  onDelete,
}: {
  state: WorkflowState;
  onConfirm: (f: EditStateForm) => void;
  onCancel: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const [form, setForm] = useState<EditStateForm>({
    label: state.label,
    color: state.color ?? "",
    isTerminal: state.isTerminal,
    slaHours: state.slaHours !== null ? String(state.slaHours) : "",
  });

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    if (!form.label.trim()) return;
    onConfirm(form);
  }

  return (
    <Dialog
      open={true}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent style={overlayCardStyle}>
        <DialogTitle asChild>
          <div style={overlayTitleStyle}>Edit State — {state.name}</div>
        </DialogTitle>
        <form onSubmit={submit}>
          <label style={labelStyle}>Display label</label>
          <input
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            style={inputStyle}
            required
            autoFocus
          />
          <label style={labelStyle}>Color (hex, optional)</label>
          <input
            value={form.color}
            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
            placeholder="#6366f1"
            style={inputStyle}
          />
          <label style={labelStyle}>SLA hours (optional)</label>
          <input
            type="number"
            min={1}
            value={form.slaHours}
            onChange={(e) =>
              setForm((f) => ({ ...f, slaHours: e.target.value }))
            }
            placeholder="e.g. 24"
            style={inputStyle}
          />
          <label
            style={{
              ...labelStyle,
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <input
              type="checkbox"
              checked={form.isTerminal}
              onChange={(e) =>
                setForm((f) => ({ ...f, isTerminal: e.target.checked }))
              }
            />
            Terminal state
          </label>
          <div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
            <button type="submit" style={btnPrimaryStyle}>
              Save
            </button>
            <button type="button" onClick={onCancel} style={btnSecondaryStyle}>
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              style={{
                ...btnSecondaryStyle,
                color: "#ef4444",
                borderColor: "#ef4444",
              }}
            >
              Delete
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type TransPanelData = {
  mode: "new" | "edit";
  id?: string;
  fromState: string;
  toState: string;
  label: string;
  allowedRoles: string;
  requiresComment: boolean;
};

function TransitionPanel({
  data,
  onConfirm,
  onCancel,
  onDelete,
}: {
  data: TransPanelData;
  onConfirm: (d: TransPanelData) => void;
  onCancel: () => void;
  onDelete?: () => void;
}): React.ReactElement {
  const [form, setForm] = useState(data);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    onConfirm(form);
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        width: "280px",
        height: "100%",
        background: "var(--bg-card, #fff)",
        borderLeft: "1px solid var(--border-color, #e5e7eb)",
        zIndex: 20,
        padding: "18px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        overflowY: "auto",
        boxShadow: "-4px 0 16px rgba(0,0,0,.06)",
      }}
    >
      <div style={{ ...overlayTitleStyle, marginBottom: 0 }}>
        {form.mode === "new" ? "New Transition" : "Edit Transition"}
      </div>
      <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
        {form.fromState} → {form.toState}
      </div>
      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: "10px" }}
      >
        <div>
          <label style={labelStyle}>Label</label>
          <input
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="e.g. Approve"
            style={inputStyle}
            autoFocus
          />
        </div>
        <div>
          <label style={labelStyle}>Allowed roles (comma-separated)</label>
          <input
            value={form.allowedRoles}
            onChange={(e) =>
              setForm((f) => ({ ...f, allowedRoles: e.target.value }))
            }
            placeholder="e.g. admin, manager"
            style={inputStyle}
          />
        </div>
        <label
          style={{
            ...labelStyle,
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <input
            type="checkbox"
            checked={form.requiresComment}
            onChange={(e) =>
              setForm((f) => ({ ...f, requiresComment: e.target.checked }))
            }
          />
          Requires comment
        </label>
        <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
          <button type="submit" style={btnPrimaryStyle}>
            {form.mode === "new" ? "Add" : "Save"}
          </button>
          <button type="button" onClick={onCancel} style={btnSecondaryStyle}>
            Cancel
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              style={{
                ...btnSecondaryStyle,
                color: "#ef4444",
                borderColor: "#ef4444",
              }}
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ── Shared overlay styles ─────────────────────────────────────────────────────

const overlayCardStyle: React.CSSProperties = {
  background: "var(--bg-card, #fff)",
  border: "1px solid var(--border-color, #e5e7eb)",
  borderRadius: "12px",
  padding: "20px 22px",
  width: "320px",
  boxShadow: "0 8px 32px rgba(0,0,0,.12)",
};

const overlayTitleStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 700,
  marginBottom: "14px",
  color: "var(--text-primary, #111)",
};

const labelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-secondary, #555)",
  display: "block",
  marginBottom: "4px",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: "12px",
  border: "1px solid var(--border-color, #e5e7eb)",
  borderRadius: "6px",
  background: "var(--bg-primary, #fff)",
  color: "var(--text-primary, #111)",
  marginBottom: "10px",
  boxSizing: "border-box",
};

const btnPrimaryStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 600,
  background: "var(--accent-primary, #6366f1)",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const btnSecondaryStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 600,
  background: "transparent",
  color: "var(--text-secondary, #555)",
  border: "1px solid var(--border-color, #e5e7eb)",
  borderRadius: "6px",
  cursor: "pointer",
};

// ── Main canvas component ────────────────────────────────────────────────────

export function WorkflowCanvas({
  states,
  transitions,
  initialState,
  workflowId,
  isAdmin,
  onSave,
  onDirtyChange,
}: CanvasProps): React.ReactElement {
  // Per-instance counter for temporary IDs — useRef avoids module-level mutable state
  // which would cause ID collisions between React 18 StrictMode double-renders and
  // between multiple canvas instances mounted on the same page.
  const newCounterRef = useRef(0);
  function newId(): string {
    return `${NEW_PREFIX}${++newCounterRef.current}`;
  }

  // ── Draft state (local edits, not yet persisted) ────────────────────────
  const [draftStates, setDraftStates] = useState<WorkflowState[]>(states);
  const [draftTransitions, setDraftTransitions] =
    useState<WorkflowTransition[]>(transitions);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset draft when workflowId changes (navigating to different workflow)
  useEffect(() => {
    setDraftStates(states);
    setDraftTransitions(transitions);
    setDirty(false);
  }, [workflowId]); // intentionally excludes states/transitions — only reset on workflow navigation

  // ── Overlay state ────────────────────────────────────────────────────────
  const [showAddState, setShowAddState] = useState(false);
  const [editingState, setEditingState] = useState<WorkflowState | null>(null);
  const [transPanel, setTransPanel] = useState<TransPanelData | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // ── Selection tracking (for Delete key) ─────────────────────────────────
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);

  // ── Dirty tracking ───────────────────────────────────────────────────────
  function markDirty(): void {
    if (!dirty) {
      setDirty(true);
      onDirtyChange?.(true);
    }
  }

  // ── statesByName for edge resolution ────────────────────────────────────
  const statesByName = useMemo(
    () => new Map(draftStates.map((s) => [s.name, s])),
    [draftStates],
  );

  // ── Node/edge callbacks (stable refs for NODE_TYPES) ────────────────────
  const handleNodeDoubleClick = useCallback((id: string) => {
    setDraftStates((ss) => {
      const s = ss.find((x) => x.id === id);
      if (s) setEditingState(s);
      return ss;
    });
  }, []);

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.preventDefault();
      setDraftStates((ss) => {
        const s = ss.find((x) => x.id === id);
        if (s) setEditingState(s);
        return ss;
      });
    },
    [],
  );

  const nodeCallbacks = useMemo(
    () => ({
      onDoubleClick: handleNodeDoubleClick,
      onContextMenu: handleNodeContextMenu,
    }),
    [handleNodeDoubleClick, handleNodeContextMenu],
  );

  // ── Build RF nodes/edges from draft ─────────────────────────────────────
  const initialNodes = useMemo(() => {
    const raw = buildNodes(draftStates, initialState, isAdmin, nodeCallbacks);
    const edges = buildEdges(draftTransitions, statesByName);
    const saved = loadPositions(workflowId);
    if (saved) {
      return raw.map((n) => {
        const pos = saved[n.id];
        return pos ? { ...n, position: pos } : n;
      });
    }
    return applyDagreLayout(raw, edges);
  }, []); // intentionally only on mount — initial layout seed

  const initialEdges = useMemo(
    () => buildEdges(draftTransitions, statesByName),
    [], // intentionally only on mount — initial edge seed
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync RF state when draft changes (add/remove nodes)
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const saved = loadPositions(workflowId);
      return draftStates.map((s) => {
        const existing = prevById.get(s.id);
        if (existing) {
          // Update data in-place (label, color, etc. may have changed)
          return {
            ...existing,
            data: {
              ...existing.data,
              state: s,
              isAdmin,
              onDoubleClick: handleNodeDoubleClick,
              onContextMenu: handleNodeContextMenu,
            },
          };
        }
        // New state — position from saved or place at 0,0 (will be placed on add)
        const pos = saved?.[s.id] ?? { x: 0, y: 0 };
        return {
          id: s.id,
          type: "stateNode",
          position: pos,
          data: {
            state: s,
            isInitial: s.name === initialState,
            isAdmin,
            onDoubleClick: handleNodeDoubleClick,
            onContextMenu: handleNodeContextMenu,
          },
          draggable: true,
        };
      });
    });
    setEdges(buildEdges(draftTransitions, statesByName));
  }, [
    draftStates,
    draftTransitions,
    initialState,
    isAdmin,
    statesByName,
    workflowId,
    setNodes,
    setEdges,
    handleNodeDoubleClick,
    handleNodeContextMenu,
  ]);

  // ── Persist positions on drag ────────────────────────────────────────────
  const onNodeDragStop = useCallback(() => {
    savePositions(workflowId, nodes as Node<StateNodeData>[]);
  }, [nodes, workflowId]);

  // ── Delete key handler ───────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!isAdmin) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Ignore if focus is on an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (selectedEdgeIds.length > 0) {
        const toDelete = selectedEdgeIds;
        setDraftTransitions((ts) => ts.filter((t) => !toDelete.includes(t.id)));
        setSelectedEdgeIds([]);
        markDirty();
      }

      if (selectedNodeIds.length > 0) {
        const [nodeId] = selectedNodeIds;
        if (!nodeId) return;
        const state = draftStates.find((s) => s.id === nodeId);
        if (!state) return;
        const affectedTransitions = draftTransitions.filter(
          (t) => t.fromState === state.name || t.toState === state.name,
        );
        if (affectedTransitions.length > 0) {
          setConfirmDelete({
            message: `Delete "${state.label}"? This will also remove ${affectedTransitions.length} transition${affectedTransitions.length !== 1 ? "s" : ""}.`,
            onConfirm: () => {
              deleteState(nodeId);
              setConfirmDelete(null);
            },
          });
        } else {
          deleteState(nodeId);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    isAdmin,
    selectedNodeIds,
    selectedEdgeIds,
    draftStates,
    draftTransitions,
  ]);

  // ── State operations ─────────────────────────────────────────────────────
  function addState(
    form: AddStateForm,
    position: { x: number; y: number },
  ): void {
    const id = newId();
    const state: WorkflowState = {
      id,
      name: form.name,
      label: form.label,
      color: null,
      isTerminal: false,
      slaHours: null,
      sortOrder: draftStates.length,
    };
    setDraftStates((ss) => [...ss, state]);
    // Place node at the click position
    setNodes((prev) => [
      ...prev,
      {
        id,
        type: "stateNode",
        position,
        data: {
          state,
          isInitial: false,
          isAdmin,
          onDoubleClick: handleNodeDoubleClick,
          onContextMenu: handleNodeContextMenu,
        },
        draggable: true,
      },
    ]);
    markDirty();
  }

  function updateState(id: string, form: EditStateForm): void {
    setDraftStates((ss) =>
      ss.map((s) =>
        s.id === id
          ? {
              ...s,
              label: form.label.trim(),
              color: form.color.trim() || null,
              isTerminal: form.isTerminal,
              slaHours: form.slaHours ? parseInt(form.slaHours, 10) : null,
            }
          : s,
      ),
    );
    markDirty();
  }

  function deleteState(id: string): void {
    const state = draftStates.find((s) => s.id === id);
    if (!state) return;
    setDraftStates((ss) => ss.filter((s) => s.id !== id));
    setDraftTransitions((ts) =>
      ts.filter((t) => t.fromState !== state.name && t.toState !== state.name),
    );
    markDirty();
  }

  // ── Transition operations ────────────────────────────────────────────────
  function addTransition(data: TransPanelData): void {
    const t: WorkflowTransition = {
      id: newId(),
      fromState: data.fromState,
      toState: data.toState,
      label: data.label.trim(),
      allowedRoles: data.allowedRoles
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
      requiresComment: data.requiresComment,
      requiresFields: [],
    };
    setDraftTransitions((ts) => [...ts, t]);
    markDirty();
  }

  function updateTransition(data: TransPanelData): void {
    if (!data.id) return;
    setDraftTransitions((ts) =>
      ts.map((t) =>
        t.id === data.id
          ? {
              ...t,
              label: data.label.trim(),
              allowedRoles: data.allowedRoles
                .split(",")
                .map((r) => r.trim())
                .filter(Boolean),
              requiresComment: data.requiresComment,
            }
          : t,
      ),
    );
    markDirty();
  }

  function deleteTransition(id: string): void {
    setDraftTransitions((ts) => ts.filter((t) => t.id !== id));
    markDirty();
  }

  // ── onConnect (draw transition by dragging handle) ───────────────────────
  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const srcState = draftStates.find((s) => s.id === conn.source);
      const tgtState = draftStates.find((s) => s.id === conn.target);
      if (!srcState || !tgtState) return;
      setTransPanel({
        mode: "new",
        fromState: srcState.name,
        toState: tgtState.name,
        label: "",
        allowedRoles: "",
        requiresComment: false,
      });
    },
    [draftStates],
  );

  // ── onEdgeClick (edit transition) ────────────────────────────────────────
  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      if (!isAdmin) return;
      const t = draftTransitions.find((x) => x.id === edge.id);
      if (!t) return;
      setTransPanel({
        mode: "edit",
        id: t.id,
        fromState: t.fromState,
        toState: t.toState,
        label: t.label,
        allowedRoles: t.allowedRoles.join(", "),
        requiresComment: t.requiresComment,
      });
    },
    [isAdmin, draftTransitions],
  );

  // ── Save / discard ───────────────────────────────────────────────────────
  async function handleSave(): Promise<void> {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ states: draftStates, transitions: draftTransitions });
      setDirty(false);
      onDirtyChange?.(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard(): void {
    setDraftStates(states);
    setDraftTransitions(transitions);
    setDirty(false);
    onDirtyChange?.(false);
    setSaveError(null);
    // Rebuild RF nodes/edges from original props
    const raw = buildNodes(states, initialState, isAdmin, nodeCallbacks);
    const edgesRaw = buildEdges(
      transitions,
      new Map(states.map((s) => [s.name, s])),
    );
    const saved = loadPositions(workflowId);
    setNodes(
      saved
        ? raw.map((n) => {
            const pos = saved[n.id];
            return pos ? { ...n, position: pos } : n;
          })
        : applyDagreLayout(raw, edgesRaw),
    );
    setEdges(edgesRaw);
  }

  function resetLayout(): void {
    localStorage.removeItem(posKey(workflowId));
    const raw = buildNodes(draftStates, initialState, isAdmin, nodeCallbacks);
    const edgesRaw = buildEdges(draftTransitions, statesByName);
    setNodes(applyDagreLayout(raw, edgesRaw));
  }

  // ── Double-click on pane to add state ────────────────────────────────────
  const [pendingAddPos, setPendingAddPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const rfWrapperRef = useRef<HTMLDivElement>(null);

  function onPaneDoubleClick(e: React.MouseEvent): void {
    if (!isAdmin) return;
    const rect = rfWrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Convert screen coords to RF canvas coords (rough — good enough for placement)
    const x = e.clientX - rect.left - NODE_W / 2;
    const y = e.clientY - rect.top - NODE_H / 2;
    setPendingAddPos({ x, y });
    setShowAddState(true);
  }

  return (
    <div
      ref={rfWrapperRef}
      style={{ position: "relative", width: "100%", height: "420px" }}
    >
      {/* Toolbar */}
      <div
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          zIndex: 10,
          display: "flex",
          gap: "6px",
          alignItems: "center",
        }}
      >
        {isAdmin && dirty && (
          <>
            {saveError && (
              <span
                style={{
                  fontSize: "11px",
                  color: "#ef4444",
                  maxWidth: "160px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {saveError}
              </span>
            )}
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              style={{
                ...btnPrimaryStyle,
                fontSize: "11px",
                padding: "4px 12px",
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? "Saving…" : "● Save"}
            </button>
            <button
              onClick={handleDiscard}
              disabled={saving}
              style={{
                ...btnSecondaryStyle,
                fontSize: "11px",
                padding: "4px 10px",
              }}
            >
              Discard
            </button>
          </>
        )}
        {isAdmin && !dirty && (
          <span
            style={{
              fontSize: "10px",
              color: "var(--text-muted)",
              fontStyle: "italic",
            }}
          >
            Double-click canvas to add state
          </span>
        )}
        <button
          onClick={resetLayout}
          style={{
            padding: "4px 10px",
            fontSize: "11px",
            fontWeight: 600,
            background: "var(--bg-secondary, #f8f8f8)",
            border: "1px solid var(--border-color, #e5e7eb)",
            borderRadius: "6px",
            cursor: "pointer",
            color: "var(--text-secondary, #555)",
          }}
        >
          Reset layout
        </button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={isAdmin ? onNodesChange : undefined}
        onEdgesChange={isAdmin ? onEdgesChange : undefined}
        onNodeDragStop={isAdmin ? onNodeDragStop : undefined}
        onConnect={isAdmin ? onConnect : undefined}
        onEdgeClick={isAdmin ? onEdgeClick : undefined}
        onPaneClick={() => {
          setSelectedNodeIds([]);
          setSelectedEdgeIds([]);
        }}
        onSelectionChange={({ nodes: ns, edges: es }) => {
          setSelectedNodeIds(ns.map((n) => n.id));
          setSelectedEdgeIds(es.map((e) => e.id));
        }}
        onDoubleClick={onPaneDoubleClick}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        nodesDraggable={isAdmin}
        nodesConnectable={isAdmin}
        elementsSelectable={isAdmin}
        deleteKeyCode={null}
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        maxZoom={2.5}
        style={{
          background: "var(--bg-tertiary, #f4f4f6)",
          borderRadius: "8px",
        }}
      >
        <Background
          color="var(--border-color, #e5e7eb)"
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
        />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const d = n.data as StateNodeData | undefined;
            return d?.state.color ?? "#6366f1";
          }}
          style={{ background: "var(--bg-secondary, #f0f0f3)" }}
        />
      </ReactFlow>

      {/* Overlays */}
      {showAddState && (
        <AddStateDialog
          onConfirm={(form) => {
            addState(form, pendingAddPos ?? { x: 80, y: 80 });
            setShowAddState(false);
            setPendingAddPos(null);
          }}
          onCancel={() => {
            setShowAddState(false);
            setPendingAddPos(null);
          }}
        />
      )}

      {editingState && (
        <EditStateDialog
          state={editingState}
          onConfirm={(form) => {
            updateState(editingState.id, form);
            setEditingState(null);
          }}
          onCancel={() => setEditingState(null)}
          onDelete={() => {
            const affectedTransitions = draftTransitions.filter(
              (t) =>
                t.fromState === editingState.name ||
                t.toState === editingState.name,
            );
            const doDelete = (): void => {
              deleteState(editingState.id);
              setEditingState(null);
              setConfirmDelete(null);
            };
            if (affectedTransitions.length > 0) {
              setConfirmDelete({
                message: `Delete "${editingState.label}"? This will also remove ${affectedTransitions.length} transition${affectedTransitions.length !== 1 ? "s" : ""}.`,
                onConfirm: doDelete,
              });
            } else {
              doDelete();
            }
          }}
        />
      )}

      {transPanel && (
        <TransitionPanel
          data={transPanel}
          onConfirm={(d) => {
            if (d.mode === "new") addTransition(d);
            else updateTransition(d);
            setTransPanel(null);
          }}
          onCancel={() => setTransPanel(null)}
          {...(transPanel.mode === "edit" && transPanel.id
            ? (() => {
                const tid = transPanel.id;
                return {
                  onDelete: () => {
                    deleteTransition(tid);
                    setTransPanel(null);
                  },
                };
              })()
            : {})}
        />
      )}

      <ConfirmDeleteDialog
        open={confirmDelete !== null}
        message={confirmDelete?.message ?? ""}
        busy={false}
        onConfirm={() => confirmDelete?.onConfirm()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
