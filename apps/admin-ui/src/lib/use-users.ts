import { useState, useEffect } from "react";
import { fetchWithAuth, API_URL } from "./api.js";

export type TenantUser = {
  userId: string;
  email: string | null;
  displayName: string | null;
  createdAt?: string;
  roles?: string[];
};

let inFlightUsersPromise: Promise<TenantUser[]> | null = null;
let cachedUsers: TenantUser[] | null = null;

export async function fetchUsersShared(): Promise<TenantUser[]> {
  if (cachedUsers !== null) return cachedUsers;
  if (inFlightUsersPromise !== null) return inFlightUsersPromise;

  inFlightUsersPromise = fetchWithAuth(`${API_URL}/users`)
    .then((res) => {
      const r = res as { data?: TenantUser[] };
      cachedUsers = r.data ?? [];
      return cachedUsers;
    })
    .catch(() => {
      return [];
    })
    .finally(() => {
      inFlightUsersPromise = null;
    });

  return inFlightUsersPromise;
}

export function clearUsersCache(): void {
  cachedUsers = null;
  inFlightUsersPromise = null;
}

export function useUsers(): { users: TenantUser[]; loading: boolean } {
  const [users, setUsers] = useState<TenantUser[]>(cachedUsers ?? []);
  const [loading, setLoading] = useState(cachedUsers === null);

  useEffect(() => {
    let cancelled = false;
    if (cachedUsers !== null) {
      setUsers(cachedUsers);
      setLoading(false);
      return;
    }

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
