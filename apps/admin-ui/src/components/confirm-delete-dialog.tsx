import React from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
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
 */

export interface ConfirmDeleteDialogProps {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  errorMessage?: string | null;
  confirmLabel?: string;
  busyLabel?: string;
  busy: boolean;
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
  busy,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps): React.ReactElement {
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
            disabled={busy}
            style={{ minWidth: 90 }}
          >
            {busy ? busyLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
