import { and, desc, eq } from "drizzle-orm";
import {
  withTenantContext,
  orgEmployees,
  orgDirectorySyncRuns,
} from "@platform/db";
import type { OrgNode, OrgTree, SyncStatus } from "./types.js";

/**
 * docs/specs/org-directory.md T6 -- the query API. Reads org_employees /
 * org_directory_sync_runs only; never calls out to an auth provider (that's
 * sync.ts's job, via OrgSourceImporter). Consumers needing manager-chain
 * traversal for workflow/automation routing (approvals, escalation) go
 * through getChainToRoot / getReportsByLevel rather than walking parentId
 * themselves.
 */

interface EmployeeRow {
  id: string;
  userId: string | null;
  parentId: string | null;
  name: string;
  title: string;
  department: string;
  email: string;
  isRoot: boolean;
}

function toNode(row: EmployeeRow): OrgNode {
  return {
    userId: row.userId ?? row.id,
    parentId: row.parentId,
    name: row.name,
    title: row.title,
    department: row.department,
    email: row.email,
    isRoot: row.isRoot,
  };
}

async function fetchAllRows(tenantId: string): Promise<EmployeeRow[]> {
  return withTenantContext(tenantId, (tx) =>
    tx
      .select({
        id: orgEmployees.id,
        userId: orgEmployees.userId,
        parentId: orgEmployees.parentId,
        name: orgEmployees.name,
        title: orgEmployees.title,
        department: orgEmployees.department,
        email: orgEmployees.email,
        isRoot: orgEmployees.isRoot,
      })
      .from(orgEmployees)
      .where(eq(orgEmployees.tenantId, tenantId)),
  );
}

export async function getOrgTree(tenantId: string): Promise<OrgTree | null> {
  const rows = await fetchAllRows(tenantId);
  const rootRow = rows.find((r) => r.isRoot);
  if (!rootRow) return null;

  const nodesByParentId: Record<string, OrgNode[]> = {};
  for (const row of rows) {
    if (row.isRoot) continue;
    const parentKey = row.parentId ?? "";
    const bucket = nodesByParentId[parentKey] ?? [];
    bucket.push(toNode(row));
    nodesByParentId[parentKey] = bucket;
  }

  return { root: toNode(rootRow), nodesByParentId };
}

/**
 * Upward chain of command from `userId` to the root, inclusive of `userId`'s
 * own node, exclusive of the synthetic root card itself (callers that need
 * the root's display name can read tree.root separately). Returns [] if
 * userId isn't found for this tenant.
 */
export async function getChainToRoot(
  tenantId: string,
  userId: string,
): Promise<OrgNode[]> {
  const rows = await fetchAllRows(tenantId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const start = rows.find((r) => r.userId === userId);
  if (!start) return [];

  const chain: OrgNode[] = [];
  let current: EmployeeRow | undefined = start;
  const seen = new Set<string>();
  while (current && !current.isRoot) {
    if (seen.has(current.id)) break; // guard against any residual cycle
    seen.add(current.id);
    chain.push(toNode(current));
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

/**
 * All of `userId`'s reports, grouped by level (level 1 = direct reports,
 * level 2 = their reports, ...) down to leaves. Returns [] if userId isn't
 * found or has no reports.
 */
export async function getReportsByLevel(
  tenantId: string,
  userId: string,
): Promise<OrgNode[][]> {
  const rows = await fetchAllRows(tenantId);
  const start = rows.find((r) => r.userId === userId);
  if (!start) return [];

  const childrenByParentId = new Map<string, EmployeeRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const bucket = childrenByParentId.get(row.parentId) ?? [];
    bucket.push(row);
    childrenByParentId.set(row.parentId, bucket);
  }

  const levels: OrgNode[][] = [];
  let frontier = childrenByParentId.get(start.id) ?? [];
  const seen = new Set<string>([start.id]);
  while (frontier.length > 0) {
    levels.push(frontier.map(toNode));
    const next: EmployeeRow[] = [];
    for (const row of frontier) {
      if (seen.has(row.id)) continue; // guard against any residual cycle
      seen.add(row.id);
      next.push(...(childrenByParentId.get(row.id) ?? []));
    }
    frontier = next;
  }
  return levels;
}

export async function getSyncStatus(tenantId: string): Promise<SyncStatus> {
  const [running] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ id: orgDirectorySyncRuns.id })
      .from(orgDirectorySyncRuns)
      .where(
        and(
          eq(orgDirectorySyncRuns.tenantId, tenantId),
          eq(orgDirectorySyncRuns.status, "running"),
        ),
      )
      .limit(1),
  );

  const [lastFinished] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        status: orgDirectorySyncRuns.status,
        completedAt: orgDirectorySyncRuns.completedAt,
      })
      .from(orgDirectorySyncRuns)
      .where(
        and(
          eq(orgDirectorySyncRuns.tenantId, tenantId),
          eq(orgDirectorySyncRuns.status, "completed"),
        ),
      )
      .orderBy(desc(orgDirectorySyncRuns.completedAt))
      .limit(1),
  );

  const [lastAttempt] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        status: orgDirectorySyncRuns.status,
        completedAt: orgDirectorySyncRuns.completedAt,
        startedAt: orgDirectorySyncRuns.startedAt,
      })
      .from(orgDirectorySyncRuns)
      .where(eq(orgDirectorySyncRuns.tenantId, tenantId))
      .orderBy(desc(orgDirectorySyncRuns.startedAt))
      .limit(1),
  );

  const lastSyncedAt = lastFinished?.completedAt?.toISOString() ?? null;

  return {
    lastSyncedAt,
    lastSyncOk: lastAttempt?.status !== "failed",
    staleSinceMs: lastSyncedAt
      ? Date.now() - new Date(lastSyncedAt).getTime()
      : null,
    syncInProgress: running !== undefined,
  };
}
