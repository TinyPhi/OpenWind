import React from "react";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { authProvider } from "../../authProvider.js";
import { CreateSandboxModal } from "./create-sandbox-modal.js";
import { SandboxRowActions } from "./sandbox-row-actions.js";

interface PlatformAdminSession {
  userId: string;
  displayName: string;
  email: string;
}

interface SandboxView {
  id: string;
  name: string;
  isSandbox: boolean;
  createdAt: string;
  trialStatus: "none" | "active" | "expired";
}

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- the platform-admin dashboard's list/create/
 * reset/delete surface, built on T19's GET /platform-admin/sandboxes list endpoint.
 * Reached only after RequirePlatformAdmin (role) and RequirePlatformAdminMfa (MFA) both
 * pass (slice 1).
 */
export function PlatformAdminDashboard(): React.ReactElement {
  const [session, setSession] = React.useState<PlatformAdminSession | null>(
    null,
  );
  const [sandboxes, setSandboxes] = React.useState<SandboxView[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const refresh = React.useCallback((): void => {
    fetchWithAuth(`${API_URL}/platform-admin/sandboxes`)
      .then((res) => {
        setSandboxes((res as { data: SandboxView[] }).data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(
          err instanceof Error ? err.message : "Could not load sandboxes",
        );
      });
  }, []);

  React.useEffect(() => {
    fetchWithAuth(`${API_URL}/platform-admin/session`)
      .then((res) => {
        setSession((res as { data: PlatformAdminSession }).data);
      })
      .catch(() => {
        // Non-fatal -- the dashboard is still usable without the identity banner;
        // RequirePlatformAdminMfa already confirmed the session is valid to get here.
      });
    refresh();
  }, [refresh]);

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
        <div>
          <h1 style={{ margin: 0 }}>Platform Admin</h1>
          {session && (
            <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>
              Signed in as {session.displayName} ({session.email})
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={() => void handleLogout()}>
          Log out
        </Button>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Sandboxes</h2>
        <div>
          <Button
            variant="secondary"
            onClick={refresh}
            style={{ marginRight: 8 }}
          >
            Refresh
          </Button>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create sandbox
          </Button>
        </div>
      </div>

      {loadError && (
        <p role="alert" style={{ color: "var(--danger, #dc2626)" }}>
          {loadError}
        </p>
      )}

      {sandboxes?.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>No sandboxes yet.</p>
      )}

      {sandboxes && sandboxes.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr
              style={{
                textAlign: "left",
                borderBottom: "1px solid var(--border-color, #e5e7eb)",
              }}
            >
              <th style={{ padding: "8px 4px" }}>Name</th>
              <th style={{ padding: "8px 4px" }}>Trial</th>
              <th style={{ padding: "8px 4px" }}>Created</th>
              <th style={{ padding: "8px 4px" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sandboxes.map((s) => (
              <tr
                key={s.id}
                style={{
                  borderBottom: "1px solid var(--border-color, #e5e7eb)",
                }}
              >
                <td style={{ padding: "8px 4px" }}>{s.name}</td>
                <td style={{ padding: "8px 4px" }}>{s.trialStatus}</td>
                <td style={{ padding: "8px 4px" }}>
                  {new Date(s.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "8px 4px" }}>
                  <SandboxRowActions
                    tenantId={s.id}
                    tenantName={s.name}
                    onDone={refresh}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateSandboxModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
    </div>
  );
}
