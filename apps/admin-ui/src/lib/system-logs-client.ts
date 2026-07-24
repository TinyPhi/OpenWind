import { API_URL, fetchWithAuth } from "./api.js";

export interface SystemLogEntry {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

interface ListResponse {
  data: SystemLogEntry[];
  nextCursor: string | null;
}

export async function listSystemLogs(cursor?: string): Promise<ListResponse> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const res = (await fetchWithAuth(
    `${API_URL}/admin/system-logs?${params.toString()}`,
  )) as { data: SystemLogEntry[]; meta: { nextCursor: string | null } };
  return { data: res.data, nextCursor: res.meta.nextCursor };
}
