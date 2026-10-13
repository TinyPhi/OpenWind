import React from "react";
import { createPortal } from "react-dom";
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
 * button is what's disabled while a request is in flight. The open menu is portalled to
 * document.body with fixed positioning: rendered in place, the table's overflow-x scroll box
 * (and the detail drawer) clipped it. React events still bubble through the component tree,
 * so the row's stopPropagation keeps a menu click from selecting the row.
 */

// Rough rendered height of the three-item menu, used only to decide whether it fits below
// the button or should open upward.
const MENU_HEIGHT_ESTIMATE = 130;
const MENU_GAP = 6;

interface MenuPosition {
  right: number;
  top?: number;
  bottom?: number;
}

function menuPositionFor(button: HTMLElement): MenuPosition {
  const rect = button.getBoundingClientRect();
  const right = window.innerWidth - rect.right;
  if (rect.bottom + MENU_GAP + MENU_HEIGHT_ESTIMATE > window.innerHeight) {
    return { right, bottom: window.innerHeight - rect.top + MENU_GAP };
  }
  return { right, top: rect.bottom + MENU_GAP };
}
export function SandboxRowActions({
  tenantId,
  tenantName,
  trialEndsAt,
  onDone,
}: SandboxRowActionsProps): React.ReactElement {
  const [confirming, setConfirming] = React.useState<ActionKind | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [menuPosition, setMenuPosition] = React.useState<MenuPosition | null>(
    null,
  );
  const [trialOpen, setTrialOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuOpen = menuPosition !== null;

  React.useEffect(() => {
    if (!menuOpen) return;
    function close(): void {
      setMenuPosition(null);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    // Capture phase so scrolling the table's own scroll box or the drawer closes it too --
    // a fixed menu would otherwise stay put while its button scrolls away.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen]);

  function toggleMenu(): void {
    if (menuOpen || !buttonRef.current) {
      setMenuPosition(null);
      return;
    }
    setMenuPosition(menuPositionFor(buttonRef.current));
  }

  function choose(open: () => void): void {
    setMenuPosition(null);
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
        ref={buttonRef}
        type="button"
        className="rcd-kebab-btn"
        aria-label={`Actions for ${tenantName}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={toggleMenu}
      >
        {busy ? "…" : "⋮"}
      </button>
      {menuPosition &&
        createPortal(
          <>
            <div
              className="rcd-kebab-backdrop"
              style={{ zIndex: 60 }}
              aria-hidden="true"
              onClick={() => setMenuPosition(null)}
            />
            <div
              className="rcd-kebab-menu"
              role="menu"
              style={{
                position: "fixed",
                zIndex: 61,
                right: menuPosition.right,
                top: menuPosition.top ?? "auto",
                bottom: menuPosition.bottom ?? "auto",
              }}
            >
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
          </>,
          document.body,
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
