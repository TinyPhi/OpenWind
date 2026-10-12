import React from "react";
import { IconButton } from "@platform/ui";
import { SandboxRowActions } from "./sandbox-row-actions.js";
import { ActivityTimeline } from "./activity-timeline.js";
import { TRIAL_BADGE, relativeTime, type TenantView } from "./format.js";

export interface TenantDetailPanelProps {
  tenant: TenantView;
  tenantNames: ReadonlyMap<string, string>;
  currentUserId: string | null;
  refreshKey: number;
  onClose: () => void;
  /** Called after a sandbox reset/delete; the panel closes itself afterwards. */
  onActionDone: () => void;
}

/**
 * Side drawer for one tenant: the same allow-listed metadata the list already holds (no
 * extra fetch, no business data -- spec R2) plus that tenant's own action timeline.
 */
export function TenantDetailPanel({
  tenant,
  tenantNames,
  currentUserId,
  refreshKey,
  onClose,
  onActionDone,
}: TenantDetailPanelProps): React.ReactElement {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trial = TRIAL_BADGE[tenant.trialStatus];

  return (
    <>
      <div
        className="pa-drawer-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="pa-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${tenant.name} details`}
      >
        <div className="pa-drawer-header">
          <div>
            <h2 className="page-title" style={{ margin: 0 }}>
              {tenant.name}
            </h2>
            <div className="pa-badges">
              <span
                className={`badge ${tenant.isSandbox ? "badge-primary" : "badge-muted"}`}
              >
                {tenant.isSandbox ? "Sandbox" : "Customer"}
              </span>
              <span className={`badge ${trial.cls}`}>{trial.label}</span>
            </div>
          </div>
          <IconButton aria-label="Close details" onClick={onClose}>
            ✕
          </IconButton>
        </div>

        <dl className="pa-meta">
          <dt>Tenant ID</dt>
          <dd className="pa-id" style={{ fontSize: 13 }}>
            {tenant.id}
          </dd>
          <dt>Created</dt>
          <dd>
            {new Date(tenant.createdAt).toLocaleString()} (
            {relativeTime(tenant.createdAt)})
          </dd>
          <dt>Trial</dt>
          <dd>{trial.label}</dd>
        </dl>

        {tenant.isSandbox ? (
          <section>
            <h3 className="pa-panel-title" style={{ marginBottom: 10 }}>
              Actions
            </h3>
            <SandboxRowActions
              tenantId={tenant.id}
              tenantName={tenant.name}
              onDone={onActionDone}
            />
          </section>
        ) : (
          <p className="pa-muted">
            Customer tenant: view only. Reset and delete apply to sandboxes
            only.
          </p>
        )}

        <section>
          <h3 className="pa-panel-title" style={{ marginBottom: 12 }}>
            Activity
          </h3>
          <ActivityTimeline
            targetTenantId={tenant.id}
            tenantNames={tenantNames}
            currentUserId={currentUserId}
            refreshKey={refreshKey}
            compact
          />
        </section>
      </aside>
    </>
  );
}
