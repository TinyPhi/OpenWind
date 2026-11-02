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
import { useTranslation } from "react-i18next";
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

export interface PolicyFormData {
  severity: Severity;
  teamId: string;
  workflowTypeId: string;
  channels: Channel[];
  notifyBackup: boolean;
  notifyEscalationManager: boolean;
}

export interface SimulatorFormData {
  severity: Severity;
  teamId: string;
  workflowTypeId: string;
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
  const { t } = useTranslation();
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
      .catch(() => showAlert(t("notificationPolicies.failedToLoad")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const teamName = (teamId: string | null): string =>
    teamId
      ? (teams.find((t) => t.id === teamId)?.name ?? "—")
      : t("notificationPolicies.anyTeam");
  const workflowName = (workflowId: string | null): string =>
    workflowId
      ? (workflows.find((w) => w.id === workflowId)?.name ?? "—")
      : t("notificationPolicies.anyWorkflow");

  async function handleDelete(policy: NotificationPolicy): Promise<void> {
    try {
      await fetchWithAuth(
        `${API_URL}/admin/notification-policies/${policy.id}`,
        { method: "DELETE" },
      );
      setDeleting(null);
      refresh();
    } catch {
      showAlert(t("notificationPolicies.failedToDelete"));
    }
  }

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">{t("notificationPolicies.loading")}</span>
      </div>
    );
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">{t("notificationPolicies.title")}</h2>
          <p className="page-subtitle">{t("notificationPolicies.subtitle")}</p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t("notificationPolicies.newPolicy")}
          </Button>
        </div>
      </div>

      {policies.length === 0 ? (
        <div className="wfl-empty">
          <h4>{t("notificationPolicies.noPolicies")}</h4>
          <p>{t("notificationPolicies.noPoliciesDesc")}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("notificationPolicies.severity")}</TableHead>
              <TableHead>{t("notificationPolicies.team")}</TableHead>
              <TableHead>{t("notificationPolicies.workflow")}</TableHead>
              <TableHead>{t("notificationPolicies.channels")}</TableHead>
              <TableHead>{t("notificationPolicies.backup")}</TableHead>
              <TableHead>{t("notificationPolicies.escalationMgr")}</TableHead>
              <TableHead style={{ width: 120 }}>
                {t("notificationPolicies.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.id}>
                <TableCell>{policy.severity}</TableCell>
                <TableCell>{teamName(policy.teamId)}</TableCell>
                <TableCell>{workflowName(policy.workflowTypeId)}</TableCell>
                <TableCell>{policy.channels.join(", ")}</TableCell>
                <TableCell>
                  {policy.notifyBackup
                    ? t("notificationPolicies.yes")
                    : t("notificationPolicies.no")}
                </TableCell>
                <TableCell>
                  {policy.notifyEscalationManager
                    ? t("notificationPolicies.yes")
                    : t("notificationPolicies.no")}
                </TableCell>
                <TableCell>
                  <div style={{ display: "flex", gap: 6 }}>
                    <IconButton
                      aria-label={t("notificationPolicies.editPolicy")}
                      onClick={() => setEditing(policy)}
                    >
                      ✎
                    </IconButton>
                    <IconButton
                      aria-label={t("notificationPolicies.deletePolicy")}
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
          <AlertDialogTitle>
            {t("notificationPolicies.deleteTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? `The "${deleting.severity}" policy for ${teamName(deleting.teamId)} / ${workflowName(deleting.workflowTypeId)} will be removed.`
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("notificationPolicies.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && void handleDelete(deleting)}
            >
              {t("notificationPolicies.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ResolveSimulator teams={teams} workflows={workflows} />
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

function getInitialPolicyFormData(policy?: NotificationPolicy): PolicyFormData {
  return {
    severity: policy?.severity ?? "high",
    teamId: policy?.teamId ?? "",
    workflowTypeId: policy?.workflowTypeId ?? "",
    channels: policy?.channels ? [...policy.channels] : ["email"],
    notifyBackup: policy?.notifyBackup ?? true,
    notifyEscalationManager: policy?.notifyEscalationManager ?? false,
  };
}

const INITIAL_SIMULATOR_FORM_DATA: SimulatorFormData = {
  severity: "high",
  teamId: "",
  workflowTypeId: "",
};

function PolicyFormModal({
  open,
  policy,
  teams,
  workflows,
  onClose,
  onSaved,
}: PolicyFormModalProps): React.ReactElement {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<PolicyFormData>(() =>
    getInitialPolicyFormData(policy),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFormData(getInitialPolicyFormData(policy));
      setError(null);
    }
  }, [open, policy]);

  function toggleChannel(channel: Channel): void {
    setFormData((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((c) => c !== channel)
        : [...prev.channels, channel],
    }));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (formData.channels.length === 0) {
      setError(t("notificationPolicies.selectChannel"));
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
          severity: formData.severity,
          teamId: formData.teamId || undefined,
          workflowTypeId: formData.workflowTypeId || undefined,
          channels: formData.channels,
          notifyBackup: formData.notifyBackup,
          notifyEscalationManager: formData.notifyEscalationManager,
        }),
      });
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("notificationPolicies.failedToSave"),
      );
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
              {policy
                ? t("notificationPolicies.editPolicy")
                : t("notificationPolicies.newPolicy")}
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
            <label className="form-label">
              {t("notificationPolicies.severity")} *
            </label>
            <select
              className="form-input"
              value={formData.severity}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  severity: e.target.value as Severity,
                }))
              }
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">
              {t("notificationPolicies.team")}
            </label>
            <select
              className="form-input"
              value={formData.teamId}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  teamId: e.target.value,
                }))
              }
            >
              <option value="">{t("notificationPolicies.anyTeam")}</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">
              {t("notificationPolicies.workflow")}
            </label>
            <select
              className="form-input"
              value={formData.workflowTypeId}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  workflowTypeId: e.target.value,
                }))
              }
            >
              <option value="">{t("notificationPolicies.anyWorkflow")}</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">
              {t("notificationPolicies.channels")} *
            </label>
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
                    checked={formData.channels.includes(c)}
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
                checked={formData.notifyBackup}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    notifyBackup: e.target.checked,
                  }))
                }
              />
              {t("notificationPolicies.notifyBackup")}
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
                checked={formData.notifyEscalationManager}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    notifyEscalationManager: e.target.checked,
                  }))
                }
              />
              {t("notificationPolicies.notifyEscalation")}
            </label>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={saving}
            style={{ marginTop: 8 }}
          >
            {saving
              ? t("notificationPolicies.saving")
              : policy
                ? t("notificationPolicies.saveChanges")
                : t("notificationPolicies.createPolicy")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResolveSimulator({
  teams,
  workflows,
}: {
  teams: Team[];
  workflows: WorkflowOption[];
}): React.ReactElement {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<SimulatorFormData>(
    INITIAL_SIMULATOR_FORM_DATA,
  );
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResolve(): Promise<void> {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ severity: formData.severity });
      if (formData.teamId) params.set("teamId", formData.teamId);
      if (formData.workflowTypeId) {
        params.set("workflowTypeId", formData.workflowTypeId);
      }
      const res = await fetchWithAuth(
        `${API_URL}/admin/notification-policies/resolve?${params.toString()}`,
      );
      setResult((res as { data: ResolveResult }).data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("notificationPolicies.failedToResolve"),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 32 }}>
      <h3 className="page-title" style={{ fontSize: 16 }}>
        {t("notificationPolicies.previewTitle")}
      </h3>
      <p className="page-subtitle">
        {t("notificationPolicies.previewSubtitle")}
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
          <label className="form-label">
            {t("notificationPolicies.severity")}
          </label>
          <select
            className="form-input"
            value={formData.severity}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                severity: e.target.value as Severity,
              }))
            }
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">{t("notificationPolicies.team")}</label>
          <select
            className="form-input"
            value={formData.teamId}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                teamId: e.target.value,
              }))
            }
          >
            <option value="">{t("notificationPolicies.none")}</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">
            {t("notificationPolicies.workflow")}
          </label>
          <select
            className="form-input"
            value={formData.workflowTypeId}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                workflowTypeId: e.target.value,
              }))
            }
          >
            <option value="">{t("notificationPolicies.none")}</option>
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
          {loading
            ? t("notificationPolicies.resolving")
            : t("notificationPolicies.resolve")}
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
            <strong>{t("notificationPolicies.matched")}:</strong>{" "}
            {result.matchedAt}
          </div>
          <div>
            <strong>{t("notificationPolicies.channels")}:</strong>{" "}
            {result.channels.join(", ")}
          </div>
          <div>
            <strong>{t("notificationPolicies.notifyBackup")}:</strong>{" "}
            {result.notifyBackup
              ? t("notificationPolicies.yes")
              : t("notificationPolicies.no")}
          </div>
          <div>
            <strong>{t("notificationPolicies.notifyEscalation")}:</strong>{" "}
            {result.notifyEscalationManager
              ? t("notificationPolicies.yes")
              : t("notificationPolicies.no")}
          </div>
          <div>
            <strong>{t("notificationPolicies.recipients")}:</strong>{" "}
            {result.recipients.length === 0
              ? t("notificationPolicies.none")
              : result.recipients
                  .map((r) => `${r.name ?? r.userId} (${r.role})`)
                  .join(", ")}
          </div>
        </div>
      )}
    </div>
  );
}
