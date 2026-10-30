import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "@dagrejs/dagre";
import { userManager } from "../authProvider.js";
import {
  getOrgTree,
  getOrgSyncStatus,
  triggerOrgSync,
  type OrgNode,
  type OrgTree,
  type SyncStatus,
} from "../lib/org-directory-client.js";
import { relativeTime } from "../lib/format.js";

// docs/specs/org-directory.md T7 — the org chart page. Visible to every
// authenticated tenant user (R7); only the manual "Sync now" button is
// admin-gated (also enforced server-side by the route itself — this is a UX
// affordance, not the security boundary).
//
// Loads fully expanded for a small organisation, and to depth 3 for a large one;
// deeper levels expand on demand per node (R8). Search matches name or email, highlights the match, and
// auto-expands its ancestor path so it's visible in context (R9).

// Same duplicated profile-role-parsing pattern as users.tsx (no shared
// hook for this exists yet — out of scope to introduce one here).
function getRolesFromProfile(
  profile: Record<string, unknown> | undefined,
): string[] {
  if (!profile) return [];
  const rolesMap = (profile["urn:zitadel:iam:org:project:roles"] ??
    {}) as Record<string, unknown>;
  return Object.keys(rolesMap);
}

const DEFAULT_EXPAND_DEPTH = 3;
// Up to this many people the whole chart opens expanded: a chain of managers is deeper than
// DEFAULT_EXPAND_DEPTH and would otherwise hide most of a small organisation behind collapsed cards.
const EXPAND_ALL_UP_TO = 60;

// Counts what the chart can reach from the root, the same nodes collectDefaultExpanded walks.
function countNodes(tree: OrgTree): number {
  const seen = new Set<string>();
  const pending = [tree.root.userId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const child of tree.nodesByParentId[id] ?? [])
      pending.push(child.userId);
  }
  return seen.size;
}

function collectDefaultExpanded(tree: OrgTree, maxDepth: number): Set<string> {
  const limit =
    countNodes(tree) <= EXPAND_ALL_UP_TO ? Number.POSITIVE_INFINITY : maxDepth;
  const expanded = new Set<string>();
  function walk(node: OrgNode, depth: number): void {
    if (depth >= limit) return;
    expanded.add(node.userId);
    for (const child of tree.nodesByParentId[node.userId] ?? []) {
      walk(child, depth + 1);
    }
  }
  walk(tree.root, 0);
  return expanded;
}

function buildParentByUserId(tree: OrgTree): Map<string, string> {
  const parentByUserId = new Map<string, string>();
  for (const [parentId, children] of Object.entries(tree.nodesByParentId)) {
    for (const child of children) {
      parentByUserId.set(child.userId, parentId);
    }
  }
  return parentByUserId;
}

function ancestorChain(
  userId: string,
  parentByUserId: Map<string, string>,
): string[] {
  const chain: string[] = [];
  let current: string | undefined = parentByUserId.get(userId);
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parentByUserId.get(current);
  }
  return chain;
}

function matchesSearch(node: OrgNode, query: string): boolean {
  if (!query) return false;
  const q = query.toLowerCase();
  return (
    node.name.toLowerCase().includes(q) || node.email.toLowerCase().includes(q)
  );
}

function OrgCard({
  node,
  highlighted,
}: {
  node: OrgNode;
  highlighted: boolean;
}): React.ReactElement {
  return (
    <div
      className={highlighted ? undefined : "org-card-interactive"}
      style={{
        borderRadius: "var(--radius-md)",
        border: highlighted
          ? "2px solid hsl(35,90%,50%)"
          : "1px solid var(--border-color)",
        background: highlighted
          ? "hsla(35,90%,50%,.1)"
          : node.isRoot
            ? "var(--accent-gradient)"
            : "var(--bg-secondary)",
        padding: "10px 14px",
        minWidth: "180px",
        maxWidth: "220px",
        boxShadow: highlighted ? "0 0 0 3px hsla(35,90%,50%,.25)" : "none",
      }}
    >
      <div
        style={{
          fontSize: "13px",
          fontWeight: 700,
          color: node.isRoot ? "#fff" : "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {node.name}
      </div>
      {!node.isRoot && (
        <>
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.title || "—"}
          </div>
          <div
            style={{
              fontSize: "10px",
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.department || "—"}
          </div>
          <div
            style={{
              fontSize: "10px",
              color: "var(--text-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {node.email || "—"}
          </div>
        </>
      )}
    </div>
  );
}

const CARD_W = 220;
const CARD_H = 96;

interface OrgFlowNodeData {
  node: OrgNode;
  highlighted: boolean;
  hasChildren: boolean;
  isExpanded: boolean;
  onToggle: (userId: string) => void;
}

const HIDDEN_HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  pointerEvents: "none",
};

function OrgFlowNode({ data }: NodeProps<OrgFlowNodeData>): React.ReactElement {
  const { node, highlighted, hasChildren, isExpanded, onToggle } = data;
  return (
    <div style={{ position: "relative" }}>
      <Handle
        type="target"
        position={Position.Top}
        style={HIDDEN_HANDLE_STYLE}
      />
      <OrgCard node={node} highlighted={highlighted} />
      {hasChildren && (
        <button
          type="button"
          className="nodrag nopan"
          onClick={() => onToggle(node.userId)}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          style={{
            position: "absolute",
            bottom: "-10px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "20px",
            height: "20px",
            borderRadius: "50%",
            border: "1px solid var(--border-color)",
            background: "var(--bg-primary)",
            color: "var(--text-secondary)",
            fontSize: "12px",
            fontWeight: 700,
            lineHeight: 1,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1,
          }}
        >
          {isExpanded ? "−" : "+"}
        </button>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        style={HIDDEN_HANDLE_STYLE}
      />
    </div>
  );
}

const NODE_TYPES = { org: OrgFlowNode };

// Lays out only the currently-expanded part of the tree, top-down.
function layoutVisibleTree(
  tree: OrgTree,
  expanded: Set<string>,
  highlightedUserId: string | null,
  onToggle: (userId: string) => void,
): { nodes: Node<OrgFlowNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 56 });

  const visible: OrgNode[] = [];
  const edges: Edge[] = [];
  function walk(node: OrgNode): void {
    visible.push(node);
    g.setNode(node.userId, { width: CARD_W, height: CARD_H });
    if (!expanded.has(node.userId)) return;
    for (const child of tree.nodesByParentId[node.userId] ?? []) {
      g.setEdge(node.userId, child.userId);
      edges.push({
        id: `${node.userId}->${child.userId}`,
        source: node.userId,
        target: child.userId,
        type: "smoothstep",
        style: { stroke: "var(--border-color)", strokeWidth: 1.5 },
      });
      walk(child);
    }
  }
  walk(tree.root);

  dagre.layout(g as Parameters<typeof dagre.layout>[0]);

  const nodes = visible.map((node): Node<OrgFlowNodeData> => {
    const pos = g.node(node.userId) as { x: number; y: number };
    return {
      id: node.userId,
      type: "org",
      position: { x: pos.x - CARD_W / 2, y: pos.y - CARD_H / 2 },
      draggable: false,
      data: {
        node,
        highlighted: highlightedUserId === node.userId,
        hasChildren: (tree.nodesByParentId[node.userId] ?? []).length > 0,
        isExpanded: expanded.has(node.userId),
        onToggle,
      },
    };
  });
  return { nodes, edges };
}

function OrgFlow({
  tree,
  expanded,
  onToggle,
  highlightedUserId,
  height,
}: {
  tree: OrgTree;
  expanded: Set<string>;
  onToggle: (userId: string) => void;
  highlightedUserId: string | null;
  height: string;
}): React.ReactElement {
  const { fitView } = useReactFlow();
  const { nodes, edges } = useMemo(
    () => layoutVisibleTree(tree, expanded, highlightedUserId, onToggle),
    [tree, expanded, highlightedUserId, onToggle],
  );

  // Bring a search match into view; expanding/collapsing deliberately does not
  // move the camera.
  useEffect(() => {
    if (!highlightedUserId) return;
    const t = setTimeout(() => {
      void fitView({
        nodes: [{ id: highlightedUserId }],
        maxZoom: 1,
        duration: 300,
      });
    }, 50);
    return () => clearTimeout(t);
  }, [highlightedUserId, fitView]);

  return (
    <div style={{ height, width: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll={false}
        zoomOnScroll
        minZoom={0.1}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

function formatSyncStatus(status: SyncStatus | null): string {
  if (!status) return "";
  if (status.syncInProgress) return "Sync in progress…";
  if (status.lastSyncedAt === null) return "Never synced";
  const when = relativeTime(status.lastSyncedAt);
  return status.lastSyncOk
    ? `Last synced ${when}`
    : `Last sync failed — showing data from ${when}`;
}

export function OrgDirectoryPage(): React.ReactElement {
  return <OrgChartPanel />;
}

// Shared by the /org-directory page and the modal on /users. `embedded`
// drops the page wrapper and title (the modal supplies its own header).
export function OrgChartPanel({
  embedded = false,
}: {
  embedded?: boolean;
}): React.ReactElement {
  const [tree, setTree] = useState<OrgTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  function load(): void {
    setLoading(true);
    getOrgTree()
      .then((data) => {
        setTree(data);
        if (data)
          setExpanded(collectDefaultExpanded(data, DEFAULT_EXPAND_DEPTH));
        setError(null);
      })
      .catch(() => setError("Failed to load org chart"))
      .finally(() => setLoading(false));
    getOrgSyncStatus()
      .then(setSyncStatus)
      .catch(() => setSyncStatus(null));
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    void userManager.getUser().then((u) => {
      setIsAdmin(
        getRolesFromProfile(
          u?.profile as Record<string, unknown> | undefined,
        ).includes("admin"),
      );
    });
  }, []);

  const parentByUserId = useMemo(
    () => (tree ? buildParentByUserId(tree) : new Map<string, string>()),
    [tree],
  );

  const allNodes = useMemo(() => {
    if (!tree) return [];
    const nodes: OrgNode[] = [tree.root];
    for (const children of Object.values(tree.nodesByParentId)) {
      nodes.push(...children);
    }
    return nodes;
  }, [tree]);

  const match = useMemo(
    () => allNodes.find((n) => matchesSearch(n, search.trim())) ?? null,
    [allNodes, search],
  );

  // Auto-expand the matched node's ancestor path so it's visible in context
  // (R9) -- does not collapse anything the user already had open.
  useEffect(() => {
    if (!match) return;
    const chain = ancestorChain(match.userId, parentByUserId);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of chain) next.add(id);
      return next;
    });
  }, [match, parentByUserId]);

  const toggle = useCallback((userId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  async function handleSync(): Promise<void> {
    setSyncing(true);
    try {
      await triggerOrgSync();
      load();
    } catch {
      setError("Failed to trigger sync");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className={embedded ? undefined : "dash-page"}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "12px",
          marginBottom: "20px",
        }}
      >
        <div>
          {!embedded && (
            <h2
              style={{
                fontSize: "21px",
                fontWeight: 800,
                fontFamily: "var(--font-heading)",
                color: "var(--text-primary)",
                margin: 0,
              }}
            >
              Org Chart
            </h2>
          )}
          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {formatSyncStatus(syncStatus)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={"Search by name or email…"}
            style={{
              fontSize: "12px",
              padding: "7px 14px",
              borderRadius: "999px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-secondary)",
              color: "var(--text-primary)",
              width: "220px",
              maxWidth: "100%",
            }}
          />
          {isAdmin && (
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing}
              style={{
                fontSize: "12px",
                fontWeight: 700,
                padding: "8px 16px",
                borderRadius: "999px",
                border: "1px solid var(--accent-primary)",
                background: syncing
                  ? "var(--bg-tertiary)"
                  : "var(--accent-primary)",
                color: syncing ? "var(--text-muted)" : "#fff",
                cursor: syncing ? "default" : "pointer",
              }}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          {"Loading org chart…"}
        </div>
      ) : error ? (
        <div style={{ fontSize: "13px", color: "hsl(350,80%,60%)" }}>
          {error}
        </div>
      ) : !tree ? (
        <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>
          {"No org chart yet — an admin needs to run the first sync."}
        </div>
      ) : (
        <div className="data-panel" style={{ padding: 0, overflow: "hidden" }}>
          <ReactFlowProvider>
            <OrgFlow
              tree={tree}
              expanded={expanded}
              onToggle={toggle}
              highlightedUserId={match?.userId ?? null}
              height={embedded ? "70vh" : "calc(100vh - 200px)"}
            />
          </ReactFlowProvider>
        </div>
      )}
    </div>
  );
}
