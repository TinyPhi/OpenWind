import React from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";

interface ProvisioningProgress {
  status: "pending" | "running" | "completed" | "failed";
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  error: string | null;
}

interface SandboxHandover {
  tenantId: string;
  seededAccounts: { username: string; email: string; role: "admin" | "user" }[];
  defaultPassword: string;
}

export interface CreateSandboxModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the admin dismisses the handover screen, so the parent can refresh the list. */
  onCreated: () => void;
}

const POLL_INTERVAL_MS = 2_000;

/**
 * T17 (docs/specs/multi-org-sandbox.md R5). Create -> poll progress -> one-time handover
 * reveal, mirroring CreateApiKeyModal's form/reveal two-phase shape. Polling (not a
 * WebSocket/SSE push) matches R5's own "wait-screen polls a row" design, already built
 * server-side (sandbox_provisioning_jobs, T8) for exactly this.
 */
export function CreateSandboxModal({
  open,
  onClose,
  onCreated,
}: CreateSandboxModalProps): React.ReactElement {
  const [orgName, setOrgName] = React.useState("");
  const [trialDays, setTrialDays] = React.useState("14");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<ProvisioningProgress | null>(
    null,
  );
  const [handover, setHandover] = React.useState<SandboxHandover | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const trialDaysNumber = Number(trialDays);
  const trialDaysValid =
    Number.isInteger(trialDaysNumber) &&
    trialDaysNumber >= 1 &&
    trialDaysNumber <= 365;
  const isValid = orgName.trim().length > 0 && trialDaysValid;

  function resetForm(): void {
    setOrgName("");
    setTrialDays("14");
    setJobId(null);
    setProgress(null);
    setHandover(null);
    setSubmitting(false);
    setError(null);
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = (await fetchWithAuth(`${API_URL}/platform-admin/sandboxes`, {
        method: "POST",
        body: JSON.stringify({
          orgName: orgName.trim(),
          trialDays: trialDaysNumber,
        }),
      })) as { data: { jobId: string } };
      setJobId(res.data.jobId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start provisioning",
      );
      setSubmitting(false);
    }
  }

  // Poll progress while a job is in flight; stop once it lands on a terminal status. Refs
  // (not plain `let`s) track cancellation and completion so the async closure's checks don't
  // get narrowed away by the linter as "always true" after the first early-return check.
  //
  // PR #842 review B: the handover endpoint is one-time, so it must be fetched exactly once.
  // The effect depends on jobId only -- an earlier version also depended on progress.status,
  // so the effect re-ran when the job completed and its unconditional first poll fetched the
  // handover a second time. Now the poll that first sees a terminal status marks the job done
  // and stops the interval itself, and any poll still in flight drops its result.
  const cancelledRef = React.useRef(false);
  const doneRef = React.useRef(false);
  // Indirected through a function (not a bare `cancelledRef.current` read) so TypeScript
  // can't narrow the mutable ref's value as a compile-time constant across the `await`
  // points below -- the cleanup closure sets it from outside this function entirely.
  const isCancelled = React.useCallback(
    (): boolean => cancelledRef.current,
    [],
  );
  const isDone = React.useCallback((): boolean => doneRef.current, []);

  React.useEffect(() => {
    if (!jobId) return;
    cancelledRef.current = false;
    doneRef.current = false;

    async function poll(): Promise<void> {
      if (isDone()) return;
      try {
        const res = (await fetchWithAuth(
          `${API_URL}/platform-admin/sandboxes/${jobId}/progress`,
        )) as { data: ProvisioningProgress };
        // A poll that was already in flight when another one finished the job drops out
        // here, before it can reach the one-time handover fetch below.
        if (isCancelled() || isDone()) return;
        setProgress(res.data);

        if (res.data.status === "completed") {
          doneRef.current = true;
          clearInterval(interval);
          const handoverRes = (await fetchWithAuth(
            `${API_URL}/platform-admin/sandboxes/${jobId}/handover`,
          )) as { data: SandboxHandover };
          if (!isCancelled()) setHandover(handoverRes.data);
        } else if (res.data.status === "failed") {
          doneRef.current = true;
          clearInterval(interval);
          setError(res.data.error ?? "Provisioning failed");
        }
      } catch (err) {
        if (!isCancelled()) {
          setError(
            err instanceof Error ? err.message : "Failed to load progress",
          );
        }
      }
    }

    // Created before the first poll so a poll that finishes the job can always clear it.
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
    return () => {
      cancelledRef.current = true;
      clearInterval(interval);
    };
  }, [jobId, isCancelled, isDone]);

  function handleOpenChange(next: boolean): void {
    if (next) return;
    if (handover) onCreated();
    else onClose();
    resetForm();
  }

  const isProvisioning = jobId && !handover && progress?.status !== "failed";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isProvisioning}
        style={{ maxWidth: 480 }}
      >
        {handover ? (
          <>
            <DialogTitle asChild>
              <h2 className="page-title">Sandbox ready</h2>
            </DialogTitle>
            <p className="page-subtitle">
              Copy these credentials now — they cannot be shown again.
            </p>
            <p style={{ fontWeight: 600, marginTop: 16 }}>Default password</p>
            <pre
              style={{
                padding: "12px",
                background: "var(--surface-2, #f3f4f6)",
                borderRadius: "8px",
                wordBreak: "break-all",
                userSelect: "all",
              }}
            >
              {handover.defaultPassword}
            </pre>
            <p style={{ fontWeight: 600, marginTop: 16 }}>Seeded accounts</p>
            <p style={{ color: "var(--text-muted)", margin: "0 0 6px" }}>
              Sign in with either the username or the email.
            </p>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {handover.seededAccounts.map((a) => (
                <li key={a.email}>
                  <strong>{a.username}</strong> — {a.email} ({a.role})
                </li>
              ))}
            </ul>
            <Button
              variant="primary"
              style={{ marginTop: 20 }}
              onClick={() => {
                onCreated();
                resetForm();
              }}
            >
              Done
            </Button>
          </>
        ) : jobId ? (
          <>
            <DialogTitle asChild>
              <h2 className="page-title">Creating sandbox…</h2>
            </DialogTitle>
            <p className="page-subtitle">
              {progress?.currentStep ?? "Starting…"}
            </p>
            <p style={{ color: "var(--text-muted)" }}>
              {progress
                ? `${progress.completedSteps} / ${progress.totalSteps}`
                : ""}
            </p>
            {error && (
              <p role="alert" style={{ color: "var(--danger, #dc2626)" }}>
                {error}
              </p>
            )}
            {progress?.status === "failed" && (
              <Button
                variant="secondary"
                style={{ marginTop: 16 }}
                onClick={() => {
                  onClose();
                  resetForm();
                }}
              >
                Close
              </Button>
            )}
          </>
        ) : (
          <>
            <DialogTitle asChild>
              <h2 className="page-title">New sandbox</h2>
            </DialogTitle>
            <form onSubmit={(e) => void handleCreate(e)}>
              <div className="form-group">
                <label htmlFor="org-name">Organization name</label>
                <input
                  id="org-name"
                  className="form-input"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="trial-days">Trial length (days)</label>
                <input
                  id="trial-days"
                  type="number"
                  min={1}
                  max={365}
                  step={1}
                  className="form-input"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                />
              </div>
              {error && (
                <p role="alert" style={{ color: "var(--danger, #dc2626)" }}>
                  {error}
                </p>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={!isValid || submitting}
                style={{ marginTop: 16 }}
              >
                {submitting ? "Starting…" : "Create sandbox"}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
