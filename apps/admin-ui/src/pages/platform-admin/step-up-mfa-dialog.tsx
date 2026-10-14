import React from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";

export interface StepUpMfaDialogProps {
  open: boolean;
  /** Called once a fresh code has been verified; the caller retries its action. */
  onVerified: () => void;
  onCancel: () => void;
}

type RequestError = Error & {
  status?: number;
  meta?: { retryAfterSeconds?: unknown };
};

function cooldownFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : 0;
}

/**
 * ADR-022 Decision 10 (#865): sandbox reset and delete need a code verified moments ago, on top
 * of the 12-hour MFA session. The server answers MFA_REAUTH_REQUIRED; this dialog sends a code,
 * verifies it, and hands control back so the caller can retry the action. The resend countdown
 * comes from the server (the cooldown is a config value, not a constant here), and a 429
 * restores it if the page is reopened inside the window.
 */
export function StepUpMfaDialog({
  open,
  onVerified,
  onCancel,
}: StepUpMfaDialogProps): React.ReactElement {
  const [code, setCode] = React.useState("");
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);
  const requestedFor = React.useRef(false);

  const sendCode = React.useCallback(async (): Promise<void> => {
    setSending(true);
    setSendError(null);
    try {
      const res = await fetchWithAuth(`${API_URL}/platform-admin/mfa/request`, {
        method: "POST",
      });
      // fetchWithAuth returns unknown; the one field read here is type-checked by cooldownFrom.
      const data = (res as { data?: { resendAfterSeconds?: unknown } }).data;
      setCooldown(cooldownFrom(data?.resendAfterSeconds));
    } catch (err) {
      const e = err as RequestError;
      if (e.status === 429) {
        setCooldown(cooldownFrom(e.meta?.retryAfterSeconds));
        setSendError(null);
      } else {
        setSendError(e.message || "Could not send the code");
      }
    } finally {
      setSending(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      requestedFor.current = false;
      setCode("");
      setSendError(null);
      setVerifyError(null);
      setCooldown(0);
      return;
    }
    if (requestedFor.current) return;
    requestedFor.current = true;
    void sendCode();
  }, [open, sendCode]);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setVerifying(true);
    setVerifyError(null);
    try {
      await fetchWithAuth(`${API_URL}/platform-admin/mfa/verify`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      onVerified();
    } catch (err) {
      setVerifyError(
        err instanceof Error ? err.message : "Verification failed",
      );
      setCode("");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !verifying) onCancel();
      }}
    >
      <DialogContent style={{ maxWidth: 400 }}>
        <DialogTitle asChild>
          <h2 style={{ margin: 0, fontSize: 18 }}>Confirm it's you</h2>
        </DialogTitle>
        <p style={{ color: "var(--text-secondary)", margin: "8px 0 16px" }}>
          This action can't be undone, so it needs a fresh verification. Enter
          the 6-digit code sent to your email.
        </p>
        <form onSubmit={(e) => void handleVerify(e)}>
          <input
            className="form-input"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            aria-label="Verification code"
            autoFocus
          />
          {sendError && (
            <p role="alert" style={{ color: "var(--danger)", marginTop: 8 }}>
              {sendError}
            </p>
          )}
          {verifyError && (
            <p role="alert" style={{ color: "var(--danger)", marginTop: 8 }}>
              {verifyError}
            </p>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 20,
            }}
          >
            <Button
              type="button"
              variant="secondary"
              onClick={() => void sendCode()}
              disabled={sending || verifying || cooldown > 0}
            >
              {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
            </Button>
            <span style={{ display: "flex", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                onClick={onCancel}
                disabled={verifying}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={verifying || code.length !== 6}
              >
                {verifying ? "Verifying…" : "Verify"}
              </Button>
            </span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
