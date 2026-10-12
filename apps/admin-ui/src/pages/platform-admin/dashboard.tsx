import React from "react";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { authProvider } from "../../authProvider.js";
import { CreateSandboxModal } from "./create-sandbox-modal.js";
import { TenantsTable } from "./tenants-table.js";
import { TenantDetailPanel } from "./tenant-detail-panel.js";
import { ActivityTimeline } from "./activity-timeline.js";
import type { TenantView } from "./format.js";
import "./platform-admin.css";

interface PlatformAdminSession {
  userId: string;
  displayName: string;
  email: string;
}

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- the platform-admin dashboard: every tenant
 * (GET /platform-admin/tenants, spec R2 amended 2026-10-12), sandbox create/reset/delete,
 * and the T16 activity timeline. Reached only after RequirePlatformAdmin (role) and
 * RequirePlatformAdminMfa (MFA) both pass.
 */
export function PlatformAdminDashboard(): React.ReactElement {
  const [session, setSession] = React.useState<PlatformAdminSession | null>(
    null,
  );
  const [tenants, setTenants] = React.useState<TenantView[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const refresh = React.useCallback((): void => {
    setRefreshKey((k) => k + 1);
    fetchWithAuth(`${API_URL}/platform-admin/tenants`)
      .then((res) => {
        setTenants((res as { data: TenantView[] }).data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(
          err instanceof Error ? err.message : "Could not load tenants",
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

  const tenantNames = React.useMemo(
    () => new Map((tenants ?? []).map((t) => [t.id, t.name])),
    [tenants],
  );
  const selected = tenants?.find((t) => t.id === selectedId) ?? null;
  const closePanel = React.useCallback(() => setSelectedId(null), []);

  const stats = tenants && [
    { label: "Total tenants", value: tenants.length },
    { label: "Sandboxes", value: tenants.filter((t) => t.isSandbox).length },
    { label: "Customers", value: tenants.filter((t) => !t.isSandbox).length },
    {
      label: "Active trials",
      value: tenants.filter((t) => t.trialStatus === "active").length,
    },
    {
      label: "Expired trials",
      value: tenants.filter((t) => t.trialStatus === "expired").length,
    },
  ];

  return (
    <div className="pa-page">
      <header className="pa-header">
        <div>
          <div className="pa-eyebrow">OpenWind</div>
          <h1 className="page-title" style={{ margin: 0 }}>
            Platform Admin
          </h1>
          {session && (
            <p className="page-subtitle" style={{ margin: "4px 0 0" }}>
              Signed in as {session.displayName} ({session.email})
            </p>
          )}
        </div>
        <div className="pa-header-actions">
          <Button variant="secondary" onClick={refresh}>
            Refresh
          </Button>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create sandbox
          </Button>
          <Button variant="secondary" onClick={() => void handleLogout()}>
            Log out
          </Button>
        </div>
      </header>

      {loadError && (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {loadError}
        </p>
      )}

      <section className="pa-stats" aria-label="Tenant summary">
        {(
          stats ??
          [0, 1, 2, 3, 4].map((i) => ({ label: String(i), value: null }))
        ).map((s) => (
          <div className="stat-card" key={s.label}>
            {s.value === null ? (
              <>
                <div className="pa-skeleton" style={{ width: "60%" }} />
                <div
                  className="pa-skeleton"
                  style={{ width: "30%", height: 26, marginTop: 12 }}
                />
              </>
            ) : (
              <>
                <div className="stat-title">{s.label}</div>
                <div className="stat-value">{s.value}</div>
              </>
            )}
          </div>
        ))}
      </section>

      <div className="pa-grid">
        <section className="pa-panel" aria-labelledby="pa-tenants-title">
          <div className="pa-panel-header">
            <h2 id="pa-tenants-title" className="pa-panel-title">
              Tenants
            </h2>
            {tenants && (
              <span className="pa-muted">{tenants.length} total</span>
            )}
          </div>
          {tenants ? (
            <TenantsTable
              tenants={tenants}
              onSelect={(t) => setSelectedId(t.id)}
              onActionDone={refresh}
            />
          ) : (
            !loadError && (
              <div aria-label="Loading tenants">
                {[0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="pa-skeleton"
                    style={{ height: 36, marginBottom: 10 }}
                  />
                ))}
              </div>
            )
          )}
        </section>

        <section className="pa-panel" aria-labelledby="pa-activity-title">
          <div className="pa-panel-header">
            <h2 id="pa-activity-title" className="pa-panel-title">
              Activity
            </h2>
          </div>
          <ActivityTimeline
            tenantNames={tenantNames}
            currentUserId={session?.userId ?? null}
            refreshKey={refreshKey}
          />
        </section>
      </div>

      {selected && (
        <TenantDetailPanel
          tenant={selected}
          tenantNames={tenantNames}
          currentUserId={session?.userId ?? null}
          refreshKey={refreshKey}
          onClose={closePanel}
          onActionDone={() => {
            closePanel();
            refresh();
          }}
        />
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
