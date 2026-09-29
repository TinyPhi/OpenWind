/**
 * Shared shapes for the org directory tree — see docs/specs/org-directory.md §I.
 *
 * OrgSourceImporter is the ONLY boundary allowed to talk to an external identity
 * provider. Swapping auth providers, or replacing the tree-build logic with an
 * external org-chart service later, means implementing a new OrgSourceImporter
 * — nothing else in this package should ever import a provider-specific client.
 */

export interface OrgNode {
  userId: string;
  /** Null only for the synthetic root node. */
  parentId: string | null;
  name: string;
  title: string;
  /** Lowercased at sync time (see §R6); empty string when unset. */
  department: string;
  email: string;
  isRoot: boolean;
}

export interface OrgTree {
  root: OrgNode;
  /** Keyed by parentId so the UI can lazily materialize children per expand. */
  nodesByParentId: Record<string, OrgNode[]>;
}

export interface OrgSourceRecord {
  userId: string;
  managerId: string | null;
  department: string | null;
  name: string;
  title: string;
  email: string;
}

export interface OrgSourceImporter {
  fetchAll(tenantId: string): Promise<OrgSourceRecord[]>;
}

export interface SyncResult {
  status: "completed" | "failed" | "already_running";
  syncedAt: string | null;
  employeeCount: number;
  cyclesBroken: number;
  reparented: number;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  lastSyncOk: boolean;
  staleSinceMs: number | null;
  syncInProgress: boolean;
}
