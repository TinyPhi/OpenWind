import React from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";
import { OtpVerification } from "./otp-verification.js";

export interface StepUpMfaDialogProps {
  open: boolean;
  /** Called once a fresh code has been verified; the caller retries its action. */
  onVerified: () => void;
  onCancel: () => void;
}

/**
 * ADR-022 Decision 10 (#865): sandbox reset and delete need a code verified moments ago, on top
 * of the sign-in's MFA session. The server answers MFA_REAUTH_REQUIRED; this dialog sends a
 * code, verifies it (which replaces the session token with a fresh one), and hands control
 * back so the caller can retry the action.
 */
export function StepUpMfaDialog({
  open,
  onVerified,
  onCancel,
}: StepUpMfaDialogProps): React.ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent style={{ maxWidth: 440 }}>
        <DialogTitle asChild>
          <h2 style={{ margin: 0, fontSize: 18 }}>Confirm it's you</h2>
        </DialogTitle>
        <p style={{ color: "var(--text-secondary)", margin: "8px 0 16px" }}>
          This action can't be undone, so it needs a fresh verification code.
        </p>
        {open && (
          <OtpVerification
            onVerified={onVerified}
            secondaryAction={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onCancel}
              >
                Cancel
              </Button>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
