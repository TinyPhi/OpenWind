import React, { useEffect, useMemo, useState } from "react";
import { useHoverStyle } from "@platform/ui";
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
// Loads expanded to depth 3 by default; deeper levels expand on demand per
// node (R8). Search matches name or email, highlights the match, and
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

function collectDefaultExpanded(tree: OrgTree, maxDepth: number): Set<string> {
  const expanded = new Set<string>();
  function walk(node: OrgNode, depth: number): void {
    if (depth >= maxDepth) return;
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
  const hover = useHoverStyle({
    base: { borderColor: "var(--border-color)" },
    hover: { borderColor: "var(--accent-primary)" },
  });

  return (
    <div
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
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
        ...hover.style,
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

function OrgNodeView({
  node,
  tree,
  expanded,
  onToggle,
  highlightedUserId,
}: {
  node: OrgNode;
  tree: OrgTree;
  expanded: Set<string>;
  onToggle: (userId: string) => void;
  highlightedUserId: string | null;
}): React.ReactElement {
  const children = tree.nodesByParentId[node.userId] ?? [];
  const isExpanded = expanded.has(node.userId);
  const hasChildren = children.length > 0;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", alignItems: "center" }}
    >
      <div style={{ position: "relative" }}>
        <OrgCard node={node} highlighted={highlightedUserId === node.userId} />
        {hasChildren && (
          <button
            type="button"
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
            }}
          >
            {isExpanded ? "−" : "+"}
          </button>
        )}
      </div>
      {hasChildren && isExpanded && (
        <>
          <div
            style={{
              width: "1px",
              height: "20px",
              background: "var(--border-color)",
            }}
          />
          <div style={{ display: "flex", gap: "24px", paddingTop: "0" }}>
            {children.map((child) => (
              <OrgNodeView
                key={child.userId}
                node={child}
                tree={tree}
                expanded={expanded}
                onToggle={onToggle}
                highlightedUserId={highlightedUserId}
              />
            ))}
          </div>
        </>
      )}
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

  function toggle(userId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

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
    <div className="dash-page">
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
        <div
          className="data-panel"
          style={{
            padding: "24px",
            overflowX: "auto",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <OrgNodeView
            node={tree.root}
            tree={tree}
            expanded={expanded}
            onToggle={toggle}
            highlightedUserId={match?.userId ?? null}
          />
        </div>
      )}
    </div>
  );
}
