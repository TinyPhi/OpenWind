import React from "react";
import { IconButton } from "@platform/ui";
import { SandboxRowActions } from "./sandbox-row-actions.js";
import { ActivityTimeline } from "./activity-timeline.js";
import {
  TRIAL_BADGE,
  relativeTime,
  trialCountdown,
  type SandboxView,
} from "./format.js";

export interface SandboxDetailPanelProps {
  sandbox: SandboxView;
  tenantNames: ReadonlyMap<string, string>;
  currentUserId: string | null;
  refreshKey: number;
  onClose: () => void;
  /** Called after a reset, delete or trial change. */
  onActionDone: () => void;
}

/**
 * Side drawer for one sandbox: the same allow-listed metadata the list already holds (no
 * extra fetch, no business data -- spec R2), its actions, and its own action timeline.
 */
export function SandboxDetailPanel({
  sandbox,
  tenantNames,
  currentUserId,
  refreshKey,
  onClose,
  onActionDone,
}: SandboxDetailPanelProps): React.ReactElement {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trial = TRIAL_BADGE[sandbox.trialStatus];

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
        aria-label={`${sandbox.name} details`}
      >
        <div className="pa-drawer-header">
          <div>
            <h2 className="page-title" style={{ margin: 0 }}>
              {sandbox.name}
            </h2>
            <div className="pa-badges">
              <span className={`badge ${trial.cls}`}>{trial.label}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <SandboxRowActions
              tenantId={sandbox.id}
              tenantName={sandbox.name}
              trialEndsAt={sandbox.trialEndsAt}
              onDone={onActionDone}
            />
            <IconButton aria-label="Close details" onClick={onClose}>
              ✕
            </IconButton>
          </div>
        </div>

        <dl className="pa-meta">
          <dt>Tenant ID</dt>
          <dd className="pa-id" style={{ fontSize: 13 }}>
            {sandbox.id}
          </dd>
          <dt>Created</dt>
          <dd>
            {new Date(sandbox.createdAt).toLocaleString()} (
            {relativeTime(sandbox.createdAt)})
          </dd>
          <dt>Trial ends</dt>
          <dd>
            {sandbox.trialEndsAt
              ? `${new Date(sandbox.trialEndsAt).toLocaleString()} (${trialCountdown(sandbox.trialEndsAt)})`
              : "No trial end set"}
          </dd>
        </dl>

        <section>
          <h3 className="pa-panel-title" style={{ marginBottom: 12 }}>
            Activity
          </h3>
          <ActivityTimeline
            targetTenantId={sandbox.id}
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
