import { API_URL, fetchWithAuth } from "./api.js";

export interface AccessLogRow {
  id: string;
  timestamp: string;
  applicationName: string | null;
  applicationKeyId: string;
  actingPersonId: string | null;
  ticketId: string;
  action: string;
  outcome: "allowed" | "denied";
}

export interface AccessLogFilters {
  application?: string | undefined;
  personId?: string | undefined;
  ticketId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  outcome?: "allowed" | "denied" | undefined;
  cursor?: string | undefined;
}

interface ListResponse {
  data: AccessLogRow[];
  nextCursor: string | null;
}

export async function listThirdPartyAccessLogs(
  filters: AccessLogFilters = {},
): Promise<ListResponse> {
  const params = new URLSearchParams({ limit: "50" });
  const entries = Object.entries(filters) as Array<
    [keyof AccessLogFilters, string | undefined]
  >;
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  const res = (await fetchWithAuth(
    `${API_URL}/admin/third-party-access-logs?${params.toString()}`,
  )) as ListResponse;
  return { data: res.data, nextCursor: res.nextCursor };
}
