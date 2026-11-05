import { Trans, useTranslation } from "react-i18next";
import React from "react";
import { createPortal } from "react-dom";
import { ConfirmDeleteDialog } from "../../components/confirm-delete-dialog.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { ExtendTrialDialog } from "./extend-trial-dialog.js";
import { EditBrandingDialog } from "./edit-branding-dialog.js";
import { loginLink } from "./login-link.js";
import { StepUpMfaDialog } from "./step-up-mfa-dialog.js";

type ActionKind = "reset" | "delete" | "end_trial" | "seed_org_tree";

// Path segment under /platform-admin/sandboxes/:tenantId for each confirmed action.
const ACTION_PATH: Record<ActionKind, string> = {
  reset: "reset",
  delete: "delete",
  end_trial: "trial/end",
  seed_org_tree: "seed-org-tree",
};

export interface SandboxRowActionsProps {
  tenantId: string;
  tenantName: string;
  trialEndsAt: string | null;
  logo: string | null;
  loginKey: string | null;
  /** Called after a reset, delete, trial or branding change succeeds, so the parent can refresh. */
  onDone: () => void;
}

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
 * Every action lives in one three-dot menu per row (R6a added Extend / End trial); the menu
 * button is what's disabled while a request is in flight. The open menu is portalled to
 * document.body with fixed positioning: rendered in place, the table's overflow-x scroll box
 * (and the detail drawer) clipped it. React events still bubble through the component tree,
 * so the row's stopPropagation keeps a menu click from selecting the row.
 */

// Rough rendered height of the three-item menu, used only to decide whether it fits below
// the button or should open upward.
const MENU_HEIGHT_ESTIMATE = 205;
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
  logo,
  loginKey,
  onDone,
}: SandboxRowActionsProps): React.ReactElement {
  const { t } = useTranslation();
  const confirmCopy: Record<
    ActionKind,
    {
      title: string;
      message: (name: string) => React.ReactNode;
      confirmLabel: string;
    }
  > = {
    reset: {
      title: t("platformAdmin.resetSandboxTitle"),
      message: (name) => (
        <Trans
          i18nKey="platformAdmin.resetSandboxMessage"
          values={{ name }}
          components={{ strong: <strong /> }}
        />
      ),
      confirmLabel: t("platformAdmin.reset"),
    },
    delete: {
      title: t("platformAdmin.deleteSandboxTitle"),
      message: (name) => (
        <Trans
          i18nKey="platformAdmin.deleteSandboxMessage"
          values={{ name }}
          components={{ strong: <strong /> }}
        />
      ),
      confirmLabel: t("platformAdmin.delete"),
    },
    end_trial: {
      title: t("platformAdmin.endTrialTitle"),
      message: (name) => (
        <Trans
          i18nKey="platformAdmin.endTrialMessage"
          values={{ name }}
          components={{ strong: <strong /> }}
        />
      ),
      confirmLabel: t("platformAdmin.endTrial"),
    },
    seed_org_tree: {
      title: t("platformAdmin.seedOrgChartDialogTitle"),
      message: (name) => t("platformAdmin.seedOrgChartDialogMessage", { name }),
      confirmLabel: t("platformAdmin.seedOrgChart"),
    },
  };
  const [confirming, setConfirming] = React.useState<ActionKind | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [menuPosition, setMenuPosition] = React.useState<MenuPosition | null>(
    null,
  );
  const [trialOpen, setTrialOpen] = React.useState(false);
  const [brandingOpen, setBrandingOpen] = React.useState(false);
  const [linkCopied, setLinkCopied] = React.useState(false);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reset and delete need a freshly verified code (ADR-022 Decision 10, #865). When the
  // server asks for one, the action waits here until the admin has verified, then retries.
  const [reauthFor, setReauthFor] = React.useState<ActionKind | null>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuOpen = menuPosition !== null;
  // PR #880 review C: only a running trial can be ended -- not one already over, and not a
  // sandbox with no trial (ending that would create an expired trial and lock users out).
  const trialActive =
    trialEndsAt !== null && Date.parse(trialEndsAt) > Date.now();

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

  React.useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  // R13: the link a prospect is sent, /login?org=<login key>, so the login page shows their brand.
  async function copyLoginLink(): Promise<void> {
    if (!loginKey) return;
    try {
      await navigator.clipboard.writeText(loginLink(loginKey));
      setLinkCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setLinkCopied(false), 2_000);
    } catch (err) {
      console.error("Sandbox login link copy failed:", err);
      showAlert("Could not copy the login link");
    }
  }

  async function runAction(
    action: ActionKind,
    afterReauth: boolean,
  ): Promise<void> {
    setBusy(true);
    try {
      await fetchWithAuth(
        `${API_URL}/platform-admin/sandboxes/${tenantId}/${ACTION_PATH[action]}`,
        { method: "POST" },
      );
      onDone();
    } catch (err) {
      // fetchWithAuth rejects with an ApiError ({ status?: number; code?: string }) on HTTP errors.
      const { status, code } = err as { status?: number; code?: string };
      if (code === "MFA_REAUTH_REQUIRED" && !afterReauth) {
        setReauthFor(action);
        return;
      }
      showAlert(
        status === 409
          ? t("platformAdmin.actionInProgress")
          : err instanceof Error
            ? err.message
            : t("platformAdmin.actionFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!confirming) return;
    const action = confirming;
    setConfirming(null);
    await runAction(action, false);
  }

  function handleReauthVerified(): void {
    const action = reauthFor;
    setReauthFor(null);
    // afterReauth: a second MFA_REAUTH_REQUIRED right after a successful verify means
    // something else is wrong (for example the session store is down), so show it
    // instead of prompting again in a loop.
    if (action) void runAction(action, true);
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
        aria-label={t("platformAdmin.actionsFor", { name: tenantName })}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={busy}
        onClick={toggleMenu}
      >
        {busy ? "…" : linkCopied ? "✓" : "⋮"}
      </button>
      <span
        role="status"
        aria-live="polite"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
        }}
      >
        {linkCopied ? "Login link copied" : ""}
      </span>
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
                {t("platformAdmin.reset")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="rcd-kebab-menu-item"
                onClick={() => choose(() => setConfirming("seed_org_tree"))}
              >
                {t("platformAdmin.seedOrgChart")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="rcd-kebab-menu-item"
                onClick={() => choose(() => setTrialOpen(true))}
              >
                {t("platformAdmin.extendTrial")}
              </button>
              <button
                type="button"
                role="menuitem"
                className="rcd-kebab-menu-item"
                onClick={() => choose(() => setBrandingOpen(true))}
              >
                {t("platformAdmin.editBranding")}
              </button>
              {loginKey && (
                <button
                  type="button"
                  role="menuitem"
                  className="rcd-kebab-menu-item"
                  onClick={() => choose(() => void copyLoginLink())}
                >
                  Copy login link
                </button>
              )}
              {trialActive && (
                <button
                  type="button"
                  role="menuitem"
                  className="rcd-kebab-menu-item"
                  onClick={() => choose(() => setConfirming("end_trial"))}
                >
                  {t("platformAdmin.endTrial")}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="rcd-kebab-menu-item"
                style={{ color: "var(--danger)" }}
                onClick={() => choose(() => setConfirming("delete"))}
              >
                {t("platformAdmin.delete")}
              </button>
            </div>
          </>,
          document.body,
        )}
      {confirming && (
        <ConfirmDeleteDialog
          open={true}
          title={confirmCopy[confirming].title}
          message={confirmCopy[confirming].message(tenantName)}
          confirmLabel={confirmCopy[confirming].confirmLabel}
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancel}
        />
      )}
      {reauthFor && (
        <StepUpMfaDialog
          open={true}
          onVerified={handleReauthVerified}
          onCancel={() => setReauthFor(null)}
        />
      )}
      {brandingOpen && (
        <EditBrandingDialog
          open={true}
          tenantId={tenantId}
          tenantName={tenantName}
          logo={logo}
          onClose={() => setBrandingOpen(false)}
          onSaved={() => {
            setBrandingOpen(false);
            onDone();
          }}
        />
      )}
      {trialOpen && (
        <ExtendTrialDialog
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
