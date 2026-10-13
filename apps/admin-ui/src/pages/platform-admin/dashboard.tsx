import React from "react";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { authProvider } from "../../authProvider.js";

interface PlatformAdminSession {
  userId: string;
  displayName: string;
  email: string;
}

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- placeholder shell. Reached only after
 * RequirePlatformAdmin (role) and RequirePlatformAdminMfa (MFA) both pass. The sandbox
 * list/create/reset/delete/handover UI is a separate, later slice built on top of this
 * shell and the GET /platform-admin/sandboxes endpoints (T19 wiring).
 */
export function PlatformAdminDashboard(): React.ReactElement {
  const [session, setSession] = React.useState<PlatformAdminSession | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetchWithAuth(`${API_URL}/platform-admin/session`)
      .then((res) => {
        setSession((res as { data: PlatformAdminSession }).data);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not load session");
      });
  }, []);

  async function handleLogout(): Promise<void> {
    const result = await authProvider.logout({});
    if (result.redirectTo) window.location.href = result.redirectTo;
  }

  return (
    <div style={{ padding: 32 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h1 style={{ margin: 0 }}>Platform Admin</h1>
        <Button variant="secondary" onClick={() => void handleLogout()}>
          Log out
        </Button>
      </div>
      {error && (
        <p role="alert" style={{ color: "var(--danger, #dc2626)" }}>
          {error}
        </p>
      )}
      {session && (
        <p style={{ color: "var(--text-muted)" }}>
          Signed in as {session.displayName} ({session.email})
        </p>
      )}
    </div>
  );
}
