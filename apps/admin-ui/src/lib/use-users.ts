import { useState, useEffect } from "react";
import { fetchWithAuth, API_URL } from "./api.js";
import { onSessionEnd } from "./session-events.js";

export type TenantUser = {
  userId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  roles?: string[];
};

// Short TTL so a newly created/renamed user shows up in pickers without a
// hard reload, while still collapsing the burst of mounts on one page.
export const USERS_CACHE_TTL_MS = 60_000;

let inFlightUsersPromise: Promise<TenantUser[]> | null = null;
let cachedUsers: TenantUser[] | null = null;
let cachedAt = 0;
// Bumped on clear so a request started before the clear can't repopulate it.
let generation = 0;

function getFreshUsers(): TenantUser[] | null {
  if (cachedUsers !== null && Date.now() - cachedAt < USERS_CACHE_TTL_MS) {
    return cachedUsers;
  }
  return null;
}

export async function fetchUsersShared(): Promise<TenantUser[]> {
  const fresh = getFreshUsers();
  if (fresh !== null) return fresh;
  if (inFlightUsersPromise !== null) return inFlightUsersPromise;

  const gen = generation;
  const request = fetchWithAuth(`${API_URL}/users`)
    .then((res) => {
      const r = res as { data?: TenantUser[] };
      const data = r.data ?? [];
      if (gen === generation) {
        cachedUsers = data;
        cachedAt = Date.now();
      }
      return data;
    })
    .catch((): TenantUser[] => {
      // Failures are not cached, so the next caller retries.
      return [];
    })
    .finally(() => {
      if (inFlightUsersPromise === request) inFlightUsersPromise = null;
    });
  inFlightUsersPromise = request;

  return request;
}

export function clearUsersCache(): void {
  generation += 1;
  cachedUsers = null;
  cachedAt = 0;
  inFlightUsersPromise = null;
}

// Drop the cache on logout so the next login in the same tab never sees the
// previous identity's user list.
onSessionEnd(clearUsersCache);

export function useUsers(): { users: TenantUser[]; loading: boolean } {
  const [users, setUsers] = useState<TenantUser[]>(getFreshUsers() ?? []);
  const [loading, setLoading] = useState(getFreshUsers() === null);

  useEffect(() => {
    const fresh = getFreshUsers();
    if (fresh !== null) {
      return;
    }

    let cancelled = false;
    void fetchUsersShared().then((data) => {
      if (!cancelled) {
        setUsers(data);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { users, loading };
}
