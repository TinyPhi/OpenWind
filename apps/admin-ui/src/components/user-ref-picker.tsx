import React, { useEffect, useState } from "react";
import { fetchUsersShared } from "../lib/use-users.js";
import { UserPicker, type UserOption } from "./user-picker.js";

/**
 * Self-fetching adapter around the existing UserPicker for `user_ref` fields
 * (#197) — UserPicker itself expects an already-loaded user list (as used by
 * the assignee pickers), so this wrapper owns the one-time `/users` fetch.
 */

async function loadUsers(): Promise<UserOption[]> {
  const data = await fetchUsersShared();
  return data.map((u) => ({
    userId: u.userId,
    displayName: u.displayName ?? u.email ?? "Unknown",
    email: u.email ?? "",
  }));
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
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadUsers().then(
      (loaded) => {
        if (!cancelled) setUsers(loaded);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <>
      <UserPicker
        users={users}
        value={value}
        onChange={onChange}
        placeholder="Select a user…"
        disabled={disabled}
      />
      {failed && (
        <div
          role="alert"
          style={{ fontSize: "12px", color: "var(--text-muted)" }}
        >
          Couldn&apos;t load users.{" "}
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            style={{ cursor: "pointer" }}
          >
            Retry
          </button>
        </div>
      )}
    </>
  );
}
