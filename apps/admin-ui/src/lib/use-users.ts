import { useState, useEffect } from "react";
import { fetchWithAuth, API_URL } from "./api.js";

export type TenantUser = {
  userId: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  roles?: string[];
};

export function useUsers(): { users: TenantUser[]; loading: boolean } {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchWithAuth(`${API_URL}/users`)
      .then((res) => {
        const r = res as { data: TenantUser[] };
        setUsers(r.data);
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, []);

  return { users, loading };
}
