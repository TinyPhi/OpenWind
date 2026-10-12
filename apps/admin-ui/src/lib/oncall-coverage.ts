import { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "./api.js";
import { onSessionEnd } from "./session-events.js";

// Coverage changes when a schedule starts or ends, not second to second, so a
// short TTL is enough to collapse every ticket opened in a minute into one
// request while still picking up a new schedule without a reload.
export const ONCALL_COVERAGE_TTL_MS = 60_000;

let inFlight: Promise<ReadonlySet<string>> | null = null;
let cachedGapTeams: ReadonlySet<string> | null = null;
let cachedAt = 0;
// Bumped on clear so a request started before the clear can't repopulate it.
let generation = 0;

function getFresh(): ReadonlySet<string> | null {
  if (
    cachedGapTeams !== null &&
    Date.now() - cachedAt < ONCALL_COVERAGE_TTL_MS
  ) {
    return cachedGapTeams;
  }
  return null;
}

/**
 * Ids of the teams that have no active on-call schedule right now, from
 * GET /admin/on-call-schedules/current (agent/admin only). Single-flight and
 * cached; a failed request rejects and is not cached, so the next caller
 * retries. Only `oncall === null` counts as a gap: a row with any other shape
 * is not treated as one.
 */
export async function fetchCoverageGapTeams(): Promise<ReadonlySet<string>> {
  const fresh = getFresh();
  if (fresh !== null) return fresh;
  if (inFlight !== null) return inFlight;

  const gen = generation;
  const request = fetchWithAuth(`${API_URL}/admin/on-call-schedules/current`)
    .then((res) => {
      const rows = (res as { data?: unknown }).data;
      const gaps = new Set<string>();
      if (Array.isArray(rows)) {
        for (const row of rows as { teamId?: unknown; oncall?: unknown }[]) {
          if (typeof row.teamId === "string" && row.oncall === null) {
            gaps.add(row.teamId);
          }
        }
      }
      if (gen === generation) {
        cachedGapTeams = gaps;
        cachedAt = Date.now();
      }
      return gaps;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
}

export function clearCoverageCache(): void {
  generation += 1;
  cachedGapTeams = null;
  cachedAt = 0;
  inFlight = null;
}

// Drop the cache on logout so the next login in the same tab never sees the
// previous tenant's coverage.
onSessionEnd(clearCoverageCache);

/**
 * Whether `teamId` currently has no on-call coverage. Makes no request unless
 * `enabled` and `teamId` are both set. The badge it feeds is advisory, so a
 * failed lookup reads as "not a gap" rather than an error state: the ticket
 * page works fine without it, and the API logs the failure server-side.
 */
export function useTeamCoverageGap(
  teamId: string | null,
  enabled: boolean,
): boolean {
  // Seed from a fresh cache so a ticket opened within the TTL shows (or does
  // not show) the badge on the first render, as use-users does.
  const [gapTeams, setGapTeams] = useState<ReadonlySet<string> | null>(() =>
    getFresh(),
  );

  useEffect(() => {
    if (!enabled || !teamId) return;
    const fresh = getFresh();
    if (fresh !== null) {
      setGapTeams(fresh);
      return;
    }
    // Never keep showing a set older than the TTL while the refetch is out.
    setGapTeams(null);
    let cancelled = false;
    fetchCoverageGapTeams().then(
      (gaps) => {
        if (!cancelled) setGapTeams(gaps);
      },
      () => {
        if (!cancelled) setGapTeams(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [teamId, enabled]);

  return enabled && !!teamId && gapTeams?.has(teamId) === true;
}
