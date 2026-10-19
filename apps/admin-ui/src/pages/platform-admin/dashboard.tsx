import React from "react";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { signOutPlatformAdmin } from "./sign-out.js";
import { CreateSandboxModal } from "./create-sandbox-modal.js";
import { SandboxesTable } from "./sandboxes-table.js";
import { SandboxDetailPanel } from "./sandbox-detail-panel.js";
import { ActivityTimeline } from "./activity-timeline.js";
import { isExpiringSoon, type SandboxView } from "./format.js";
import "./platform-admin.css";

interface PlatformAdminSession {
  userId: string;
  displayName: string;
  email: string;
}

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- the platform-admin dashboard: sandboxes only
 * (regular tenants never appear, R2), create/reset/delete/change-trial (R6a), and the T16
 * activity timeline. Reached only after RequirePlatformAdmin (role) and
 * RequirePlatformAdminMfa (MFA) both pass.
 */
export function PlatformAdminDashboard(): React.ReactElement {
  const [session, setSession] = React.useState<PlatformAdminSession | null>(
    null,
  );
  const [sandboxes, setSandboxes] = React.useState<SandboxView[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [logoutError, setLogoutError] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const isMountedRef = React.useRef(true);
  const refreshSeq = React.useRef(0);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = React.useCallback((): void => {
    setRefreshKey((k) => k + 1);
    const seq = ++refreshSeq.current;
    fetchWithAuth(`${API_URL}/platform-admin/sandboxes`)
      .then((res) => {
        if (!isMountedRef.current || seq !== refreshSeq.current) return;
        // fetchWithAuth returns unknown; { data: SandboxView[] } is the
        // platform-admin/sandboxes list contract.
        setSandboxes((res as { data: SandboxView[] }).data);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!isMountedRef.current || seq !== refreshSeq.current) return;
        setLoadError(
          err instanceof Error ? err.message : "Could not load sandboxes",
        );
      });
  }, []);

  React.useEffect(() => {
    // Ignore the answer once this effect is cleaned up, so under StrictMode (or a fast
    // remount) a slower first fetch can't overwrite the live one.
    let cancelled = false;
    fetchWithAuth(`${API_URL}/platform-admin/session`)
      .then((res) => {
        if (cancelled) return;
        // fetchWithAuth returns unknown; { data: PlatformAdminSession } is the
        // platform-admin/session contract.
        setSession((res as { data: PlatformAdminSession }).data);
      })
      .catch(() => {
        // Non-fatal -- the dashboard is still usable without the identity banner;
        // RequirePlatformAdminMfa already confirmed the session is valid to get here.
      });
    refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function handleLogout(): Promise<void> {
    setLogoutError(null);
    try {
      const redirectTo = await signOutPlatformAdmin();
      if (redirectTo) window.location.href = redirectTo;
    } catch {
      setLogoutError("Logout failed. Please try again.");
    }
  }

  const tenantNames = React.useMemo(
    () => new Map((sandboxes ?? []).map((s) => [s.id, s.name])),
    [sandboxes],
  );
  const selected = sandboxes?.find((s) => s.id === selectedId) ?? null;
  const closePanel = React.useCallback(() => setSelectedId(null), []);

  const stats = sandboxes && [
    { label: "Sandboxes", value: sandboxes.length },
    {
      label: "Active trials",
      value: sandboxes.filter((s) => s.trialStatus === "active").length,
    },
    {
      label: "Expiring within 7 days",
      value: sandboxes.filter((s) => isExpiringSoon(s.trialEndsAt)).length,
    },
    {
      label: "Expired",
      value: sandboxes.filter((s) => s.trialStatus === "expired").length,
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

      {logoutError && (
        <p role="alert" style={{ color: "var(--danger, #dc2626)" }}>
          {logoutError}
        </p>
      )}

      {loadError && (
        <p role="alert" style={{ color: "var(--danger)" }}>
          {loadError}
        </p>
      )}

      <section className="pa-stats" aria-label="Sandbox summary">
        {(
          stats ?? [0, 1, 2, 3].map((i) => ({ label: String(i), value: null }))
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
        <section className="pa-panel" aria-labelledby="pa-sandboxes-title">
          <div className="pa-panel-header">
            <h2 id="pa-sandboxes-title" className="pa-panel-title">
              Sandboxes
            </h2>
            {sandboxes && (
              <span className="pa-muted">{sandboxes.length} total</span>
            )}
          </div>
          {sandboxes ? (
            <SandboxesTable
              sandboxes={sandboxes}
              onSelect={(s) => setSelectedId(s.id)}
              onActionDone={refresh}
            />
          ) : (
            !loadError && (
              <div aria-label="Loading sandboxes">
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
        <SandboxDetailPanel
          sandbox={selected}
          tenantNames={tenantNames}
          currentUserId={session?.userId ?? null}
          refreshKey={refreshKey}
          onClose={closePanel}
          onActionDone={refresh}
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
