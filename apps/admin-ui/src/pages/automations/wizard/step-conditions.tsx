import React from "react";
import { Button, IconButton } from "@platform/ui";
import type {
  WizardData,
  ConditionNode,
  ConditionGroup,
  ConditionLeaf,
} from "./types.js";
import { genId } from "./types.js";

type Props = {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
};

const OPERATORS: Array<{
  op: ConditionLeaf["op"];
  label: string;
  hasValue: boolean;
}> = [
  { op: "eq", label: "is equal to", hasValue: true },
  { op: "neq", label: "is not equal to", hasValue: true },
  { op: "gt", label: "greater than", hasValue: true },
  { op: "gte", label: "greater than or equal", hasValue: true },
  { op: "lt", label: "less than", hasValue: true },
  { op: "lte", label: "less than or equal", hasValue: true },
  { op: "contains", label: "contains", hasValue: true },
  { op: "in", label: "is one of", hasValue: true },
  { op: "empty", label: "is empty", hasValue: false },
  { op: "not_empty", label: "is not empty", hasValue: false },
];

export function isGroup(node: ConditionNode): node is ConditionGroup {
  // "children" in node is more structurally correct but op values never overlap — both are correct
  return node.op === "and" || node.op === "or";
}

export function cloneNode(node: ConditionNode): ConditionNode {
  if (isGroup(node)) {
    // spread preserves id (and any future fields); override children with deep copies
    return { ...node, children: node.children.map(cloneNode) };
  }
  return { ...node };
}

/** Recursively assigns a stable id to any node missing one (e.g. rules loaded from server). */
export function ensureIds(node: ConditionNode): ConditionNode {
  if (isGroup(node)) {
    return {
      ...node,
      id: node.id ?? genId(),
      children: node.children.map(ensureIds),
    };
  }
  return { ...node, id: node.id ?? genId() };
}

export function updateNodeAt(
  root: ConditionGroup,
  path: number[],
  updater: (node: ConditionNode) => ConditionNode,
): ConditionGroup {
  // cloneNode returns ConditionNode; root is always a ConditionGroup so the clone is too
  const clone = cloneNode(root) as ConditionGroup;
  // updater(clone) returns ConditionNode; callers only pass group-returning updaters at root
  if (path.length === 0) return updater(clone) as ConditionGroup;

  let cursor: ConditionGroup = clone;
  for (let i = 0; i < path.length - 1; i++) {
    // noUncheckedIndexedAccess — path is caller-validated against the tree depth
    const idx = path[i] as number;
    // children at intermediate path positions are always groups (leaves have no children)
    cursor = cursor.children[idx] as ConditionGroup;
  }
  const lastIdx = path[path.length - 1] as number;
  // noUncheckedIndexedAccess — same caller-validated path guarantee
  cursor.children[lastIdx] = updater(cursor.children[lastIdx] as ConditionNode);
  return clone;
}

export function removeNodeAt(
  root: ConditionGroup,
  path: number[],
): ConditionGroup {
  // cloneNode returns ConditionNode; root is always a ConditionGroup so the clone is too
  const clone = cloneNode(root) as ConditionGroup;
  if (path.length === 0) return clone;

  let cursor: ConditionGroup = clone;
  for (let i = 0; i < path.length - 1; i++) {
    // children at intermediate path positions are always groups
    cursor = cursor.children[path[i] as number] as ConditionGroup;
  }
  cursor.children.splice(path[path.length - 1] as number, 1);
  return clone;
}

function addLeafAt(root: ConditionGroup, path: number[]): ConditionGroup {
  // cloneNode returns ConditionNode; root is always a ConditionGroup so the clone is too
  const clone = cloneNode(root) as ConditionGroup;
  let cursor: ConditionGroup = clone;
  for (const idx of path) {
    cursor = cursor.children[idx] as ConditionGroup;
  }
  cursor.children.push({ id: genId(), op: "eq", field: "", value: "" });
  return clone;
}

function addGroupAt(root: ConditionGroup, path: number[]): ConditionGroup {
  const clone = cloneNode(root) as ConditionGroup;
  let cursor: ConditionGroup = clone;
  for (const idx of path) {
    cursor = cursor.children[idx] as ConditionGroup;
  }
  cursor.children.push({
    id: genId(),
    op: "and",
    children: [{ id: genId(), op: "eq", field: "", value: "" }],
  });
  return clone;
}

// Render a single condition node recursively
function ConditionNodeEditor({
  node,
  path,
  depth,
  onUpdate,
  onRemove,
  onAddLeaf,
  onAddGroup,
}: {
  node: ConditionNode;
  path: number[];
  depth: number;
  onUpdate: (
    path: number[],
    updater: (n: ConditionNode) => ConditionNode,
  ) => void;
  onRemove: (path: number[]) => void;
  onAddLeaf: (path: number[]) => void;
  onAddGroup: (path: number[]) => void;
}): React.ReactElement {
  if (isGroup(node)) {
    return (
      <div
        style={{
          border: "1px solid var(--border-color)",
          borderRadius: "8px",
          padding: "12px 14px",
          background:
            depth % 2 === 0 ? "var(--bg-secondary)" : "var(--bg-card)",
          marginBottom: "8px",
        }}
      >
        {/* Group header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            marginBottom: "10px",
          }}
        >
          <select
            className="form-input"
            style={{ width: "80px", padding: "4px 6px", fontSize: "12px" }}
            value={node.op}
            onChange={(e) =>
              onUpdate(path, (n) => ({
                ...(n as ConditionGroup),
                op: e.target.value as "and" | "or",
              }))
            }
          >
            <option value="and">AND</option>
            <option value="or">OR</option>
          </select>
          <span
            style={{ fontSize: "11px", color: "var(--text-muted)", flex: 1 }}
          >
            Match {node.op === "and" ? "all" : "any"} of:
          </span>
          {path.length > 0 && (
            <IconButton
              variant="delete"
              style={{ fontSize: "10px" }}
              onClick={() => onRemove(path)}
              title="Remove group"
              aria-label="Remove group"
            >
              ×
            </IconButton>
          )}
        </div>

        {/* Children */}
        {node.children.map((child, i) => (
          <ConditionNodeEditor
            key={child.id ?? String(i)}
            node={child}
            path={[...path, i]}
            depth={depth + 1}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onAddLeaf={onAddLeaf}
            onAddGroup={onAddGroup}
          />
        ))}

        {/* Add buttons */}
        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
          <Button
            variant="secondary"
            style={{ fontSize: "11px", padding: "4px 10px" }}
            onClick={() => onAddLeaf(path)}
          >
            + Add condition
          </Button>
          {depth < 3 && (
            <Button
              variant="secondary"
              style={{ fontSize: "11px", padding: "4px 10px" }}
              onClick={() => onAddGroup(path)}
            >
              + Add group
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Leaf condition
  const leaf = node as ConditionLeaf;
  const opDef = OPERATORS.find((o) => o.op === leaf.op);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "8px",
        flexWrap: "wrap",
      }}
    >
      <input
        className="form-input"
        style={{ width: "140px", fontSize: "12px", padding: "4px 8px" }}
        placeholder="field.name"
        value={leaf.field}
        onChange={(e) =>
          onUpdate(path, (n) => ({
            ...(n as ConditionLeaf),
            field: e.target.value,
          }))
        }
      />
      <select
        className="form-input"
        style={{ width: "160px", fontSize: "12px", padding: "4px 8px" }}
        value={leaf.op}
        onChange={(e) =>
          onUpdate(path, (n) => ({
            ...(n as ConditionLeaf),
            op: e.target.value as ConditionLeaf["op"],
            value: "",
          }))
        }
      >
        {OPERATORS.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {opDef?.hasValue && (
        <input
          className="form-input"
          style={{ width: "140px", fontSize: "12px", padding: "4px 8px" }}
          placeholder="value"
          value={leaf.value !== undefined ? String(leaf.value) : ""}
          onChange={(e) =>
            onUpdate(path, (n) => ({
              ...(n as ConditionLeaf),
              value: e.target.value,
            }))
          }
        />
      )}
      <IconButton
        variant="delete"
        style={{ fontSize: "11px", padding: "2px 6px" }}
        onClick={() => onRemove(path)}
        title="Remove condition"
        aria-label="Remove condition"
      >
        ×
      </IconButton>
    </div>
  );
}

export function StepConditions({ data, onChange }: Props): React.ReactElement {
  const conditions = data.conditions;

  function init(): void {
    onChange({
      conditions: {
        id: genId(),
        op: "and",
        children: [{ id: genId(), op: "eq", field: "", value: "" }],
      },
    });
  }

  function clear(): void {
    onChange({ conditions: null });
  }

  function handleUpdate(
    path: number[],
    updater: (n: ConditionNode) => ConditionNode,
  ): void {
    if (!conditions) return;
    onChange({
      conditions: updateNodeAt(conditions, path, updater),
    });
  }

  function handleRemove(path: number[]): void {
    if (!conditions) return;
    onChange({ conditions: removeNodeAt(conditions, path) });
  }

  function handleAddLeaf(path: number[]): void {
    if (!conditions) return;
    onChange({ conditions: addLeafAt(conditions, path) });
  }

  function handleAddGroup(path: number[]): void {
    if (!conditions) return;
    onChange({ conditions: addGroupAt(conditions, path) });
  }

  return (
    <div>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "13px",
          marginBottom: "16px",
        }}
      >
        Optionally add conditions to filter when this rule fires. Leave empty to
        always run on trigger.
      </p>

      {!conditions ? (
        <div
          style={{
            border: "2px dashed var(--border-color)",
            borderRadius: "10px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <p
            style={{
              color: "var(--text-muted)",
              fontSize: "13px",
              marginBottom: "12px",
            }}
          >
            No conditions — rule fires on every trigger event.
          </p>
          <Button variant="secondary" onClick={init}>
            + Add conditions
          </Button>
        </div>
      ) : (
        <div>
          <ConditionNodeEditor
            node={conditions}
            path={[]}
            depth={0}
            onUpdate={handleUpdate}
            onRemove={handleRemove}
            onAddLeaf={handleAddLeaf}
            onAddGroup={handleAddGroup}
          />
          <Button
            variant="secondary"
            style={{
              fontSize: "12px",
              marginTop: "8px",
              color: "var(--danger)",
            }}
            onClick={clear}
          >
            Remove all conditions
          </Button>
        </div>
      )}
    </div>
  );
}
