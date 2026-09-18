import React, { useCallback, useEffect, useState } from "react";
import {
  Button,
  IconButton,
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const CHANNELS = ["email", "sms", "whatsapp", "call"] as const;
type Severity = (typeof SEVERITIES)[number];
type Channel = (typeof CHANNELS)[number];

interface Team {
  id: string;
  name: string;
}

interface WorkflowOption {
  id: string;
  name: string;
}

export interface NotificationPolicy {
  id: string;
  teamId: string | null;
  workflowTypeId: string | null;
  severity: Severity;
  channels: Channel[];
  notifyBackup: boolean;
  notifyEscalationManager: boolean;
}

interface ResolveResult {
  policyId: string | null;
  matchedAt: string;
  channels: Channel[];
  notifyBackup: boolean;
  notifyEscalationManager: boolean;
  recipients: { role: string; userId: string; name: string | null }[];
}

/**
 * Admin Notification Policy builder — docs/specs/oncall-routing.md T32,
 * R14/R19/R20. Severity x team x workflow-type matrix with channel toggles,
 * plus a dry-run Preview panel against GET /admin/notification-policies/resolve
 * (no side effects — matches the route's own R20 contract).
 */
export function NotificationPoliciesPage(): React.ReactElement {
  const [policies, setPolicies] = useState<NotificationPolicy[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NotificationPolicy | null>(null);
  const [deleting, setDeleting] = useState<NotificationPolicy | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/notification-policies`),
      fetchWithAuth(`${API_URL}/admin/teams`),
      fetchWithAuth(`${API_URL}/workflows`),
    ])
      .then(([policiesRes, teamsRes, workflowsRes]) => {
        setPolicies((policiesRes as { data: NotificationPolicy[] }).data);
        setTeams((teamsRes as { data: Team[] }).data);
        setWorkflows((workflowsRes as { data?: WorkflowOption[] }).data ?? []);
      })
      .catch(() => showAlert("Failed to load notification policies."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const teamName = (teamId: string | null): string =>
    teamId ? (teams.find((t) => t.id === teamId)?.name ?? "—") : "Any team";
  const workflowName = (workflowId: string | null): string =>
    workflowId
      ? (workflows.find((w) => w.id === workflowId)?.name ?? "—")
      : "Any workflow";

  async function handleDelete(policy: NotificationPolicy): Promise<void> {
    try {
      await fetchWithAuth(
        `${API_URL}/admin/notification-policies/${policy.id}`,
        { method: "DELETE" },
      );
      setDeleting(null);
      refresh();
    } catch {
      showAlert("Failed to delete policy.");
    }
  }

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading notification policies…</span>
      </div>
    );
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">Notification Policies</h2>
          <p className="page-subtitle">
            Route severity-based ticket alerts to channels, per team and
            workflow.
          </p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            New Policy
          </Button>
        </div>
      </div>

      {policies.length === 0 ? (
        <div className="wfl-empty">
          <h4>No notification policies yet</h4>
          <p>Create one to route severity-based alerts to a channel.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Workflow</TableHead>
              <TableHead>Channels</TableHead>
              <TableHead>Backup</TableHead>
              <TableHead>Escalation mgr</TableHead>
              <TableHead style={{ width: 120 }}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.id}>
                <TableCell>{policy.severity}</TableCell>
                <TableCell>{teamName(policy.teamId)}</TableCell>
                <TableCell>{workflowName(policy.workflowTypeId)}</TableCell>
                <TableCell>{policy.channels.join(", ")}</TableCell>
                <TableCell>{policy.notifyBackup ? "Yes" : "No"}</TableCell>
                <TableCell>
                  {policy.notifyEscalationManager ? "Yes" : "No"}
                </TableCell>
                <TableCell>
                  <div style={{ display: "flex", gap: 6 }}>
                    <IconButton
                      aria-label="Edit policy"
                      onClick={() => setEditing(policy)}
                    >
                      ✎
                    </IconButton>
                    <IconButton
                      aria-label="Delete policy"
                      onClick={() => setDeleting(policy)}
                    >
                      🗑
                    </IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <PolicyFormModal
        open={creating}
        teams={teams}
        workflows={workflows}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          refresh();
        }}
      />
      <PolicyFormModal
        open={editing !== null}
        policy={editing ?? undefined}
        teams={teams}
        workflows={workflows}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete notification policy?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? `The "${deleting.severity}" policy for ${teamName(deleting.teamId)} / ${workflowName(deleting.workflowTypeId)} will be removed.`
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && void handleDelete(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ResolvePreview teams={teams} workflows={workflows} />
    </div>
  );
}

interface PolicyFormModalProps {
  open: boolean;
  policy?: NotificationPolicy | undefined;
  teams: Team[];
  workflows: WorkflowOption[];
  onClose: () => void;
  onSaved: () => void;
}

function PolicyFormModal({
  open,
  policy,
  teams,
  workflows,
  onClose,
  onSaved,
}: PolicyFormModalProps): React.ReactElement {
  const [severity, setSeverity] = useState<Severity>(
    policy?.severity ?? "high",
  );
  const [teamId, setTeamId] = useState(policy?.teamId ?? "");
  const [workflowTypeId, setWorkflowTypeId] = useState(
    policy?.workflowTypeId ?? "",
  );
  const [channels, setChannels] = useState<Channel[]>(
    policy?.channels ?? ["email"],
  );
  const [notifyBackup, setNotifyBackup] = useState(
    policy?.notifyBackup ?? true,
  );
  const [notifyEscalationManager, setNotifyEscalationManager] = useState(
    policy?.notifyEscalationManager ?? false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSeverity(policy?.severity ?? "high");
      setTeamId(policy?.teamId ?? "");
      setWorkflowTypeId(policy?.workflowTypeId ?? "");
      setChannels(policy?.channels ?? ["email"]);
      setNotifyBackup(policy?.notifyBackup ?? true);
      setNotifyEscalationManager(policy?.notifyEscalationManager ?? false);
      setError(null);
    }
  }, [open, policy]);

  function toggleChannel(channel: Channel): void {
    setChannels((prev) =>
      prev.includes(channel)
        ? prev.filter((c) => c !== channel)
        : [...prev, channel],
    );
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (channels.length === 0) {
      setError("Select at least one channel");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const path = policy
        ? `${API_URL}/admin/notification-policies/${policy.id}`
        : `${API_URL}/admin/notification-policies`;
      await fetchWithAuth(path, {
        method: policy ? "PATCH" : "POST",
        body: JSON.stringify({
          severity,
          teamId: teamId || undefined,
          workflowTypeId: workflowTypeId || undefined,
          channels,
          notifyBackup,
          notifyEscalationManager,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save policy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false} style={{ maxWidth: 460 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <DialogTitle asChild>
            <h2 className="page-title">
              {policy ? "Edit Policy" : "New Policy"}
            </h2>
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                color: "var(--text-muted)",
              }}
            >
              ×
            </button>
          </DialogClose>
        </div>

        {error && (
          <div className="alert alert-error" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)}>
          <div className="form-group">
            <label className="form-label">Severity *</label>
            <select
              className="form-input"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as Severity)}
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Team</label>
            <select
              className="form-input"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">Any team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Workflow</label>
            <select
              className="form-input"
              value={workflowTypeId}
              onChange={(e) => setWorkflowTypeId(e.target.value)}
            >
              <option value="">Any workflow</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Channels *</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {CHANNELS.map((c) => (
                <label
                  key={c}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={channels.includes(c)}
                    onChange={() => toggleChannel(c)}
                  />
                  {c}
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={notifyBackup}
                onChange={(e) => setNotifyBackup(e.target.checked)}
              />
              Notify backup on-call
            </label>
          </div>
          <div className="form-group">
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={notifyEscalationManager}
                onChange={(e) => setNotifyEscalationManager(e.target.checked)}
              />
              Notify escalation manager
            </label>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={saving}
            style={{ marginTop: 8 }}
          >
            {saving ? "Saving…" : policy ? "Save changes" : "Create policy"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResolvePreview({
  teams,
  workflows,
}: {
  teams: Team[];
  workflows: WorkflowOption[];
}): React.ReactElement {
  const [severity, setSeverity] = useState<Severity>("high");
  const [teamId, setTeamId] = useState("");
  const [workflowTypeId, setWorkflowTypeId] = useState("");
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResolve(): Promise<void> {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ severity });
      if (teamId) params.set("teamId", teamId);
      if (workflowTypeId) params.set("workflowTypeId", workflowTypeId);
      const res = await fetchWithAuth(
        `${API_URL}/admin/notification-policies/resolve?${params.toString()}`,
      );
      setResult((res as { data: ResolveResult }).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 32 }}>
      <h3 className="page-title" style={{ fontSize: 16 }}>
        Preview
      </h3>
      <p className="page-subtitle">
        Dry-run the effective policy for a given severity/team/workflow — no
        notification is sent.
      </p>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "flex-end",
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Severity</label>
          <select
            className="form-input"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity)}
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Team</label>
          <select
            className="form-input"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            <option value="">None</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Workflow</label>
          <select
            className="form-input"
            value={workflowTypeId}
            onChange={(e) => setWorkflowTypeId(e.target.value)}
          >
            <option value="">None</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="primary"
          disabled={loading}
          onClick={() => void handleResolve()}
        >
          {loading ? "Resolving…" : "Resolve"}
        </Button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <div>
            <strong>Matched:</strong> {result.matchedAt}
          </div>
          <div>
            <strong>Channels:</strong> {result.channels.join(", ")}
          </div>
          <div>
            <strong>Notify backup:</strong> {result.notifyBackup ? "Yes" : "No"}
          </div>
          <div>
            <strong>Notify escalation manager:</strong>{" "}
            {result.notifyEscalationManager ? "Yes" : "No"}
          </div>
          <div>
            <strong>Recipients:</strong>{" "}
            {result.recipients.length === 0
              ? "None"
              : result.recipients
                  .map((r) => `${r.name ?? r.userId} (${r.role})`)
                  .join(", ")}
          </div>
        </div>
      )}
    </div>
  );
}
