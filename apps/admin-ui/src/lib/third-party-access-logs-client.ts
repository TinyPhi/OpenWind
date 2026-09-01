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
  // Admin-UI API Keys detail view can lock this to every key id belonging
  // to one "application" (a rotation can span multiple key rows) — the
  // standalone logs page still passes a single id, unchanged.
  application?: string | string[] | undefined;
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
    [keyof AccessLogFilters, string | string[] | undefined]
  >;
  for (const [key, value] of entries) {
    if (!value) continue;
    params.set(key, Array.isArray(value) ? value.join(",") : value);
  }
  const res = (await fetchWithAuth(
    `${API_URL}/admin/third-party-access-logs?${params.toString()}`,
  )) as Partial<ListResponse> | undefined;
  // PR #489 review, F-05 -- fetchWithAuth throws on a non-2xx response, but
  // a malformed/unexpected 2xx body (e.g. an envelope mismatch) would
  // otherwise silently produce `data: undefined`, rendering a misleadingly
  // empty table instead of surfacing an error to the admin.
  if (!Array.isArray(res?.data)) {
    throw new Error("Unexpected response shape from access-logs endpoint");
  }
  return { data: res.data, nextCursor: res.nextCursor ?? null };
}
