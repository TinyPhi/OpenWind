import React from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import {
  downloadHandoverCsv,
  formatHandoverClipboard,
} from "./sandbox-handover-csv.js";

interface ProvisioningProgress {
  status: "pending" | "running" | "completed" | "failed";
  currentStep: string | null;
  completedSteps: number;
  totalSteps: number;
  error: string | null;
}

interface SandboxHandover {
  tenantId: string;
  seededAccounts: {
    username: string;
    email: string;
    role: "admin" | "user";
    password: string;
  }[];
}

export interface CreateSandboxModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the admin dismisses the handover screen, so the parent can refresh the list. */
  onCreated: () => void;
}

const POLL_INTERVAL_MS = 2_000;

const cellStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "1px solid var(--border-color, #e5e7eb)",
  verticalAlign: "top",
};

// Standard visually-hidden pattern: present for screen readers, not drawn.
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

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
  const [downloadFailed, setDownloadFailed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);
  const [handoverFailed, setHandoverFailed] = React.useState(false);
  const copyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  React.useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

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
    setDownloadFailed(false);
    setCopied(false);
    setCopyFailed(false);
    setHandoverFailed(false);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
  }

  // A job was started and has not reported failure, so the sandbox exists or soon will, even if
  // polling lost track of it. Closing then must refresh the list, not just dismiss the dialog.
  const jobMayExist = Boolean(jobId) && progress?.status !== "failed";

  function dismiss(): void {
    if (handover || jobMayExist) onCreated();
    else onClose();
    resetForm();
  }

  async function handleCopyCredentials(): Promise<void> {
    if (!handover) return;
    setCopyFailed(false);
    setDownloadFailed(false);
    try {
      const text = formatHandoverClipboard(handover.seededAccounts);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2_000);
    } catch (err) {
      console.error("Sandbox handover clipboard copy failed:", err);
      setCopyFailed(true);
    }
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isValid) return;
    setSubmitting(true);
    setError(null);
    try {
      // fetchWithAuth returns unknown; { data: { jobId: string } } is the
      // platform-admin/sandboxes creation contract.
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
        // fetchWithAuth returns unknown; { data: ProvisioningProgress } is the
        // platform-admin/sandboxes/:id/progress contract.
        const res = (await fetchWithAuth(
          `${API_URL}/platform-admin/sandboxes/${jobId}/progress`,
        )) as { data: ProvisioningProgress };
        // A poll that was already in flight when another one finished the job drops out
        // here, before it can reach the one-time handover fetch below.
        if (isCancelled() || isDone()) return;
        setProgress(res.data);
        setError(null);

        if (res.data.status === "completed") {
          doneRef.current = true;
          clearInterval(interval);
          let handoverRes: { data: SandboxHandover };
          try {
            // fetchWithAuth returns unknown; { data: SandboxHandover } is the
            // platform-admin/sandboxes/:id/handover contract.
            handoverRes = (await fetchWithAuth(
              `${API_URL}/platform-admin/sandboxes/${jobId}/handover`,
            )) as { data: SandboxHandover };
          } catch {
            // The sandbox exists; only its one-time credentials could not be loaded. Say that,
            // not a generic "failed to load progress" (the job is done, and polling has stopped).
            if (!isCancelled()) {
              setHandoverFailed(true);
              setError(
                "The sandbox was created, but its credentials could not be loaded. The handover is shown only once, so it may not be available again. Check the sandbox list.",
              );
            }
            return;
          }
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
    dismiss();
  }

  const isProvisioning =
    jobId && !handover && progress?.status !== "failed" && !error;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isProvisioning}
        // The handover lists up to ~21 accounts with email and password side by side, so it
        // gets a wide dialog; the form and progress steps stay narrow. DialogContent is
        // width: 100% of its centred overlay, so the wide one still fits a small screen.
        style={{ maxWidth: handover ? 960 : 480 }}
      >
        {handover ? (
          <>
            <DialogTitle asChild>
              <h2 className="page-title">Sandbox ready</h2>
            </DialogTitle>
            <p className="page-subtitle">
              Copy these credentials now — they cannot be shown again.
            </p>
            <p style={{ fontWeight: 600, marginTop: 16 }}>Seeded accounts</p>
            <p style={{ color: "var(--text-muted)", margin: "0 0 6px" }}>
              Each account has its own password. Sign in with either the
              username or the email.
            </p>
            <div style={{ maxHeight: "60vh", overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={cellStyle}>Username</th>
                    <th style={cellStyle}>Email</th>
                    <th style={cellStyle}>Role</th>
                    <th style={cellStyle}>Password</th>
                  </tr>
                </thead>
                <tbody>
                  {handover.seededAccounts.map((a) => (
                    <tr key={a.email}>
                      <td style={cellStyle}>
                        <strong>{a.username}</strong>
                      </td>
                      <td style={cellStyle}>{a.email}</td>
                      <td style={cellStyle}>{a.role}</td>
                      <td style={cellStyle}>
                        <code style={{ userSelect: "all" }}>{a.password}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {downloadFailed && (
              <p
                role="alert"
                style={{ marginTop: 12, color: "var(--danger, #dc2626)" }}
              >
                Could not create the CSV. Copy the credentials above instead.
              </p>
            )}
            {copyFailed && (
              <p
                role="alert"
                style={{ marginTop: 12, color: "var(--danger, #dc2626)" }}
              >
                Could not copy credentials. Use Download CSV or copy from the
                table.
              </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <Button
                variant="secondary"
                onClick={() => {
                  setDownloadFailed(false);
                  setCopyFailed(false);
                  try {
                    downloadHandoverCsv(orgName, handover.seededAccounts);
                  } catch (err) {
                    console.error("Sandbox handover CSV download failed:", err);
                    setDownloadFailed(true);
                  }
                }}
              >
                Download CSV
              </Button>
              <Button
                variant="secondary"
                onClick={() => void handleCopyCredentials()}
              >
                {copied ? "Copied!" : "Copy credentials"}
              </Button>
              {/* Always rendered so assistive technology registers the live region before its text changes. */}
              <span role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
                {copied ? "Credentials copied to clipboard" : ""}
              </span>
              <Button
                variant="primary"
                onClick={() => {
                  onCreated();
                  resetForm();
                }}
              >
                Done
              </Button>
            </div>
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
            {error && !handoverFailed && progress?.status !== "failed" && (
              <p style={{ color: "var(--text-muted)" }}>
                The sandbox may still be created. Its credentials are shown only
                once, so closing this now means you will not see them. Check the
                sandbox list afterwards.
              </p>
            )}
            {(progress?.status === "failed" || error) && (
              <Button
                variant="secondary"
                style={{ marginTop: 16 }}
                onClick={dismiss}
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
