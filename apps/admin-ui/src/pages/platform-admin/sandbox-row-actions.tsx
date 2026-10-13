import React from "react";
import { ConfirmDeleteDialog } from "../../components/confirm-delete-dialog.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { ChangeTrialDialog } from "./change-trial-dialog.js";

type ActionKind = "reset" | "delete";

export interface SandboxRowActionsProps {
  tenantId: string;
  tenantName: string;
  trialEndsAt: string | null;
  /** Called after a reset, delete or trial change succeeds, so the parent can refresh. */
  onDone: () => void;
}

const CONFIRM_COPY: Record<
  ActionKind,
  {
    title: string;
    message: (name: string) => React.ReactNode;
    confirmLabel: string;
    busyLabel: string;
  }
> = {
  reset: {
    title: "Reset this sandbox?",
    message: (name) => (
      <>
        This wipes and re-seeds all module data in <strong>{name}</strong>. The
        org chart, accounts, and credentials are untouched.
      </>
    ),
    confirmLabel: "Reset",
    busyLabel: "Resetting…",
  },
  delete: {
    title: "Delete this sandbox?",
    message: (name) => (
      <>
        This removes the Zitadel organization and every seeded account for{" "}
        <strong>{name}</strong>, and deletes all of its OpenWind data.
      </>
    ),
    confirmLabel: "Delete",
    busyLabel: "Deleting…",
  },
};

/**
 * T17 (docs/specs/multi-org-sandbox.md). Failures are reported via the shared global
 * alert banner (showAlert), not ConfirmDeleteDialog's own errorMessage prop -- Radix's
 * AlertDialogAction fires the dialog's onOpenChange(false) synchronously on click,
 * before this component's async handleConfirm has set `busy`, so the dialog is already
 * dismissed by the time a failure response comes back; an errorMessage passed to an
 * unmounted dialog would never be seen. This matches the codebase's other working
 * confirm+async-action pattern (apps/admin-ui/src/pages/api-keys/detail.tsx's
 * handleConfirm), not the one the component's own doc comment -- "Delete workflow" in
 * workflows/detail.tsx -- which has this same unreported-failure gap.
 *
 * The 409 LIFECYCLE_ACTION_IN_PROGRESS case gets a specific message rather than a generic
 * failure -- the underlying route can legitimately take up to ~60s
 * (WAIT_FOR_RESET_TTL_MS/WAIT_FOR_DELETE_TTL_MS), so a platform admin re-clicking
 * mid-request is a normal case, not a bug report. Disabling both buttons while `busy` is
 * a client-side UX affordance only -- the real concurrency guard is the worker-held
 * sandbox-lifecycle advisory lock (T22, PR #832's fix), which this component never needs
 * to know about.
 *
 * Every action lives in one three-dot menu per row (R6a added "Change trial"); the menu
 * button is what's disabled while a request is in flight.
 */
export function SandboxRowActions({
  tenantId,
  tenantName,
  trialEndsAt,
  onDone,
}: SandboxRowActionsProps): React.ReactElement {
  const [confirming, setConfirming] = React.useState<ActionKind | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [trialOpen, setTrialOpen] = React.useState(false);

  React.useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function choose(open: () => void): void {
    setMenuOpen(false);
    open();
  }

  async function handleConfirm(): Promise<void> {
    if (!confirming) return;
    const action = confirming;
    setConfirming(null);
    setBusy(true);
    try {
      await fetchWithAuth(
        `${API_URL}/platform-admin/sandboxes/${tenantId}/${action}`,
        { method: "POST" },
      );
      onDone();
    } catch (err) {
      const status = (err as { status?: number }).status;
      showAlert(
        status === 409
          ? "Already in progress for this sandbox — try again shortly."
          : err instanceof Error
            ? err.message
            : `Failed to ${action} the sandbox`,
      );
    } finally {
      setBusy(false);
    }
  }

  function handleCancel(): void {
    setConfirming(null);
  }

  return (
    <div className="rcd-kebab-wrap">
      <button
        type="button"
        className="rcd-kebab-btn"
        aria-label={`Actions for ${tenantName}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {busy ? "…" : "⋮"}
      </button>
      {menuOpen && (
        <>
          <div
            className="rcd-kebab-backdrop"
            aria-hidden="true"
            onClick={() => setMenuOpen(false)}
          />
          <div className="rcd-kebab-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="rcd-kebab-menu-item"
              onClick={() => choose(() => setConfirming("reset"))}
            >
              Reset
            </button>
            <button
              type="button"
              role="menuitem"
              className="rcd-kebab-menu-item"
              onClick={() => choose(() => setTrialOpen(true))}
            >
              Change trial
            </button>
            <button
              type="button"
              role="menuitem"
              className="rcd-kebab-menu-item"
              style={{ color: "var(--danger)" }}
              onClick={() => choose(() => setConfirming("delete"))}
            >
              Delete
            </button>
          </div>
        </>
      )}
      {confirming && (
        <ConfirmDeleteDialog
          open={true}
          title={CONFIRM_COPY[confirming].title}
          message={CONFIRM_COPY[confirming].message(tenantName)}
          confirmLabel={CONFIRM_COPY[confirming].confirmLabel}
          busyLabel={CONFIRM_COPY[confirming].busyLabel}
          busy={false}
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancel}
        />
      )}
      {trialOpen && (
        <ChangeTrialDialog
          open={true}
          tenantId={tenantId}
          tenantName={tenantName}
          trialEndsAt={trialEndsAt}
          onClose={() => setTrialOpen(false)}
          onSaved={() => {
            setTrialOpen(false);
            onDone();
          }}
        />
      )}
    </div>
  );
}
