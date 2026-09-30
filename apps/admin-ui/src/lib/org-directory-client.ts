import { API_URL, fetchWithAuth } from "./api.js";

// docs/specs/org-directory.md T7 — mirrors @platform/org-directory's OrgNode/
// OrgTree/SyncResult/SyncStatus shapes (packages/org-directory/src/types.ts),
// redefined locally since admin-ui never imports a backend package directly.

export interface OrgNode {
  userId: string;
  parentId: string | null;
  name: string;
  title: string;
  department: string;
  email: string;
  isRoot: boolean;
}

export interface OrgTree {
  root: OrgNode;
  nodesByParentId: Record<string, OrgNode[]>;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  lastSyncOk: boolean;
  staleSinceMs: number | null;
  syncInProgress: boolean;
}

export interface SyncResult {
  status: "completed" | "failed" | "already_running";
  syncedAt: string | null;
  employeeCount: number;
  cyclesBroken: number;
  reparented: number;
}

export async function getOrgTree(): Promise<OrgTree | null> {
  const res = (await fetchWithAuth(`${API_URL}/org-directory/tree`)) as {
    data: OrgTree | null;
  };
  return res.data;
}

export async function getOrgSyncStatus(): Promise<SyncStatus> {
  const res = (await fetchWithAuth(`${API_URL}/org-directory/sync-status`)) as {
    data: SyncStatus;
  };
  return res.data;
}

export async function triggerOrgSync(): Promise<SyncResult> {
  const res = (await fetchWithAuth(`${API_URL}/org-directory/sync`, {
    method: "POST",
  })) as { data: SyncResult };
  return res.data;
}
