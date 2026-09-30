import type { OrgSourceRecord } from "./types.js";

/**
 * Pure org-tree diff/resolution algorithm — no DB, no network. Takes a fresh
 * pull from an OrgSourceImporter plus a snapshot of the previously-synced
 * tree, and produces the writes the DB layer must apply. Real Postgres/RLS
 * behavior is covered separately by isolation tests (packages/teams'
 * oncall-resolver.ts is the precedent for this split).
 *
 * docs/specs/org-directory.md R3-R6. Resolution order per R4's note: cycle
 * detection runs over the FULLY RESOLVED parent graph (after R5's prior-tree
 * reparent and R3's root-fallback have already picked a candidate parent for
 * every node) -- a cycle can only exist among nodes whose managers are all
 * still present in this sync, since a manager missing from the fresh pull is
 * immediately resolved to a real target (grandparent or root) before cycle
 * detection ever runs. This produces the same end state as a strict
 * cycle-then-reparent-then-root pass order, without needing three separate
 * graph walks.
 */

/** A previously-synced employee, keyed by userId. Root is never included --
 * a `parentUserId` of null means "resolves to the tenant's root card". */
export interface PriorEmployee {
  userId: string;
  parentUserId: string | null;
}

export interface ResolvedEmployee {
  userId: string;
  /** null means "parents to the tenant's root card". */
  parentUserId: string | null;
  name: string;
  title: string;
  /** Lowercased, trimmed; empty string when unset (R6). */
  department: string;
  email: string;
}

export interface OrgTreeBuildResult {
  /** Every employee present in this sync, with a fully resolved parent. */
  employees: ResolvedEmployee[];
  /** userIds present in the prior tree but absent from this sync -- delete. */
  removedUserIds: string[];
  cyclesBroken: number;
  /** Employees reparented to a grandparent because their manager disappeared. */
  reparented: number;
}

function normalizeDepartment(department: string | null): string {
  return (department ?? "").trim().toLowerCase();
}

export function buildOrgTree(
  fresh: OrgSourceRecord[],
  prior: PriorEmployee[],
): OrgTreeBuildResult {
  const freshByUserId = new Map(fresh.map((r) => [r.userId, r]));
  const priorByUserId = new Map(prior.map((p) => [p.userId, p]));

  // Pass 1: resolve each fresh employee's parent to either another fresh
  // employee, a grandparent via the prior tree (R5), or root (R3) -- null
  // throughout this module always means "root".
  let reparented = 0;
  const resolvedParent = new Map<string, string | null>();
  for (const record of fresh) {
    if (record.managerId === null) {
      resolvedParent.set(record.userId, null);
      continue;
    }
    if (freshByUserId.has(record.managerId)) {
      resolvedParent.set(record.userId, record.managerId);
      continue;
    }
    // managerId not present in this pull -- either it never existed (bad
    // data -> root, R3) or it existed last sync and has since disappeared
    // (R5: reparent to ITS last-known parent, one hop, no further chain-walk).
    const priorManager = priorByUserId.get(record.managerId);
    if (priorManager) {
      resolvedParent.set(record.userId, priorManager.parentUserId);
      reparented++;
    } else {
      resolvedParent.set(record.userId, null);
    }
  }

  // Pass 2: break cycles in the resolved graph. A cycle can only be formed
  // by fresh-to-fresh edges (the branch above already grounds every
  // grandparent-reparent and root-fallback edge to a non-fresh-cycling
  // target), so walking resolvedParent chains here is sufficient.
  let cyclesBroken = 0;
  const state = new Map<string, "unvisited" | "visiting" | "done">();
  for (const record of fresh) state.set(record.userId, "unvisited");

  for (const record of fresh) {
    if (state.get(record.userId) !== "unvisited") continue;
    const path: string[] = [];
    let cursor: string | null = record.userId;
    while (cursor !== null && state.get(cursor) === "unvisited") {
      state.set(cursor, "visiting");
      path.push(cursor);
      cursor = resolvedParent.get(cursor) ?? null;
    }
    if (cursor !== null && state.get(cursor) === "visiting") {
      // cursor is back inside the current path -- a cycle. Per R4, the last
      // node processed in the loop (the one whose edge closes it) falls
      // back to root, breaking the cycle at exactly one point.
      const closingNode = path.at(-1);
      if (closingNode !== undefined) {
        resolvedParent.set(closingNode, null);
        cyclesBroken++;
      }
    }
    for (const node of path) state.set(node, "done");
  }

  const employees: ResolvedEmployee[] = fresh.map((record) => ({
    userId: record.userId,
    parentUserId: resolvedParent.get(record.userId) ?? null,
    name: record.name,
    title: record.title,
    department: normalizeDepartment(record.department),
    email: record.email,
  }));

  const removedUserIds = prior
    .map((p) => p.userId)
    .filter((userId) => !freshByUserId.has(userId));

  return { employees, removedUserIds, cyclesBroken, reparented };
}
