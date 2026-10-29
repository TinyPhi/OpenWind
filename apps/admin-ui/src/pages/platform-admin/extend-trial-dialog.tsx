import { useTranslation } from "react-i18next";
import React from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 365;

export interface ExtendTrialDialogProps {
  open: boolean;
  tenantId: string;
  tenantName: string;
  trialEndsAt: string | null;
  onClose: () => void;
  /** Called after the new trial end is saved. */
  onSaved: () => void;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * R6a (docs/specs/multi-org-sandbox.md): extend a sandbox's trial by N days -- from its current
 * end while the trial is running, from today once it has ended (which reactivates it). The
 * server computes the end from its own clock; the preview is the same arithmetic in the
 * browser, so it can differ by the request's latency only.
 */
export function ExtendTrialDialog({
  open,
  tenantId,
  tenantName,
  trialEndsAt,
  onClose,
  onSaved,
}: ExtendTrialDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const [days, setDays] = React.useState("7");
  const [saving, setSaving] = React.useState(false);

  const currentEnd = trialEndsAt ? Date.parse(trialEndsAt) : null;
  const expired = currentEnd !== null && currentEnd <= Date.now();
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_DAYS;
  const base = currentEnd !== null && !expired ? currentEnd : Date.now();

  async function handleSave(): Promise<void> {
    if (!valid) return;
    setSaving(true);
    try {
      await fetchWithAuth(
        `${API_URL}/platform-admin/sandboxes/${tenantId}/trial`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trialDays: parsed }),
        },
      );
      onSaved();
    } catch (err) {
      showAlert(
        err instanceof Error
          ? err.message
          : t("platformAdmin.failedToExtendTrial"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent style={{ maxWidth: 440 }}>
        <DialogTitle asChild>
          <h2 style={{ margin: 0, fontSize: 18 }}>
            {t("platformAdmin.extendTrial")}
          </h2>
        </DialogTitle>
        <p style={{ color: "var(--text-secondary)", margin: "8px 0 16px" }}>
          <strong>{tenantName}</strong>:{" "}
          {currentEnd === null
            ? "no trial end set."
            : expired
              ? `expired on ${formatDate(currentEnd)}.`
              : `trial ends ${formatDate(currentEnd)}.`}
        </p>

        <label className="form-label" htmlFor="pa-trial-days">
          Extend by (days)
        </label>
        <input
          id="pa-trial-days"
          className="form-input"
          type="number"
          min={1}
          max={MAX_DAYS}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />

        <p className="pa-muted" style={{ marginTop: 10 }} aria-live="polite">
          {valid
            ? `New end: ${formatDate(base + parsed * DAY_MS)}`
            : `Enter a whole number from 1 to ${MAX_DAYS}.`}
        </p>
        {expired && valid && (
          <p style={{ color: "var(--success)", fontSize: 13, margin: 0 }}>
            This reactivates the sandbox: its users can sign in again straight
            away.
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={!valid || saving}
          >
            {saving
              ? t("platformAdmin.saving")
              : expired
                ? t("platformAdmin.reactivate")
                : t("platformAdmin.extend")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
