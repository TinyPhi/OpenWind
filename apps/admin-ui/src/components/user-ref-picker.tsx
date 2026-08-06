import React, { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { UserPicker, type UserOption } from "./user-picker.js";

/**
 * Self-fetching adapter around the existing UserPicker for `user_ref` fields
 * (#197) — UserPicker itself expects an already-loaded user list (as used by
 * the assignee pickers), so this wrapper owns the one-time `/users` fetch.
 */

let cachedUsers: UserOption[] | null = null;

async function loadUsers(): Promise<UserOption[]> {
  if (cachedUsers) return cachedUsers;
  const res = (await fetchWithAuth(`${API_URL}/users`)) as {
    data?: Array<{ userId: string; email: string; displayName: string | null }>;
  };
  cachedUsers = (res.data ?? []).map((u) => ({
    userId: u.userId,
    displayName: u.displayName ?? u.email,
    email: u.email,
  }));
  return cachedUsers;
}

export interface UserRefPickerProps {
  value: string | null;
  onChange: (userId: string | null) => void;
  disabled?: boolean;
}

export function UserRefPicker({
  value,
  onChange,
  disabled = false,
}: UserRefPickerProps): React.ReactElement {
  const [users, setUsers] = useState<UserOption[]>([]);

  useEffect(() => {
    void loadUsers().then(setUsers);
  }, []);

  return (
    <UserPicker
      users={users}
      value={value}
      onChange={onChange}
      placeholder="Select a user…"
      disabled={disabled}
    />
  );
}
