import React, { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  TOKENS,
} from "@platform/ui";

/**
 * Shared destructive-delete confirmation (#198), consolidating 5 hand-rolled
 * copies of the same 🗑-icon / "cannot be undone" pattern:
 * workflow-canvas.tsx's ConfirmDialog, file-attachment.tsx's
 * DeleteConfirmModal, workflows/detail.tsx's ConfirmDeleteModal AND its
 * separate bespoke "Delete workflow" modal, and automations/index.tsx's
 * inline modal. Covers every prop those five needed between them: an
 * optional title (defaults to a generic one), a ReactNode message (some
 * embed a bold item name), an optional inline error banner (only the
 * "Delete workflow" case used one), and custom confirm/busy labels (only
 * "Delete workflow" needed "Delete Workflow"/"Deleting…" instead of the
 * generic "Delete"/"Deleting…").
 *
 * `busy`/`busyLabel` only show while the caller keeps the dialog OPEN during the work.
 * AlertDialogAction (Radix) fires onOpenChange(false) synchronously on click, so a caller that
 * closes the dialog from onConfirm and then awaits a request never renders the busy state --
 * the dialog is already gone. Such callers should omit `busy` (it defaults to false), disable
 * their own trigger while the request runs, and report failures via showAlert (see
 * pages/platform-admin/sandbox-row-actions.tsx and pages/api-keys/detail.tsx).
 */

export interface ConfirmDeleteDialogProps {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  errorMessage?: string | null;
  confirmLabel?: string;
  busyLabel?: string;
  /** See the component doc: only meaningful while the dialog stays open during the work. */
  busy?: boolean;
  /**
   * For deletes that cannot be undone and hit a person or a whole record set: the user must type
   * this text exactly before the confirm button is enabled. Omit it for ordinary deletes.
   */
  typeToConfirm?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteDialog({
  open,
  title = "Delete this item?",
  message,
  errorMessage,
  confirmLabel = "Delete",
  busyLabel = "Deleting…",
  busy = false,
  typeToConfirm,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps): React.ReactElement {
  const [typed, setTyped] = useState("");
  // A new target, or reopening, starts empty: text typed for one person must never confirm another.
  useEffect(() => {
    setTyped("");
  }, [open, typeToConfirm]);
  const typedMatches =
    typeToConfirm === undefined || typed.trim() === typeToConfirm.trim();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialogContent>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: "hsla(0, 84%, 60%, 0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 20,
            marginBottom: 16,
          }}
          aria-hidden="true"
        >
          🗑
        </div>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{message}</AlertDialogDescription>
        <p
          style={{
            margin: "6px 0 0",
            fontSize: 13,
            color: "var(--danger, hsl(350, 80%, 60%))",
          }}
        >
          This action cannot be undone.
        </p>
        {typeToConfirm !== undefined && (
          <label
            style={{
              display: "block",
              margin: "16px 0 0",
              fontSize: 13,
              color: TOKENS.textSecondary,
            }}
          >
            Type{" "}
            <strong
              style={{
                color: TOKENS.textPrimary,
                background: TOKENS.bgTertiary,
                border: `1px solid ${TOKENS.borderColor}`,
                borderRadius: 4,
                padding: "1px 6px",
                fontFamily: "monospace",
                userSelect: "all",
              }}
            >
              {typeToConfirm}
            </strong>{" "}
            to confirm.
            <input
              type="text"
              className="form-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              aria-label={`Type ${typeToConfirm} to confirm`}
              placeholder={typeToConfirm}
              style={{ marginTop: 8, width: "100%" }}
            />
          </label>
        )}
        {errorMessage && (
          <p
            style={{
              margin: "16px 0 0",
              fontSize: 13,
              color: "var(--danger, hsl(350, 80%, 60%))",
            }}
          >
            ⚠ {errorMessage}
          </p>
        )}
        <AlertDialogFooter>
          {/* No onClick here: Cancel already triggers onOpenChange(false)
              on click, which calls onCancel below - an explicit handler
              here would double-fire it. */}
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={busy || !typedMatches}
            style={{ minWidth: 90 }}
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
