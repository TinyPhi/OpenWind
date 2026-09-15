import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import { useEntityTypes } from "../../entity-type-context.js";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];
type RuleStatus = "active" | "paused" | "archived";

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Daily 9am", expr: "0 9 * * *" },
  { label: "Weekly Mon 9am", expr: "0 9 * * 1" },
  { label: "Monthly 1st 9am", expr: "0 9 1 * *" },
  { label: "Quarterly", expr: "0 9 1 1,4,7,10 *" },
];

interface WorkflowOption {
  id: string;
  name: string;
}

export interface ScheduleTemplate {
  title: string;
  description?: string | undefined;
  severity?: Severity | undefined;
  assignee_id?: string | undefined;
  team_id?: string | undefined;
  service_id?: string | undefined;
}

export interface ScheduleRule {
  id: string;
  name: string;
  description: string | null;
  cronExpr: string;
  cronHuman: string | null;
  timezone: string;
  status: RuleStatus;
  entityTypeId: string;
  workflowId: string | null;
  catchUp: boolean;
  nextFireAt: string | null;
  template: ScheduleTemplate;
}

/**
 * Admin Schedule Rules list + create/edit builder —
 * docs/specs/temporal-scheduler.md T15, R1/R6.
 */
export function ScheduleRulesPage(): React.ReactElement {
  const { entityTypes } = useEntityTypes();
  const [rules, setRules] = useState<ScheduleRule[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduleRule | null>(null);
  const [deleting, setDeleting] = useState<ScheduleRule | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/schedule-rules`),
      fetchWithAuth(`${API_URL}/workflows`),
    ])
      .then(([rulesRes, workflowsRes]) => {
        setRules((rulesRes as { data: ScheduleRule[] }).data);
        setWorkflows((workflowsRes as { data?: WorkflowOption[] }).data ?? []);
      })
      .catch(() => showAlert("Failed to load schedule rules."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const entityTypeName = (id: string): string =>
    entityTypes.find((et) => et.id === id)?.plural ?? id;
  const workflowName = (id: string | null): string =>
    id ? (workflows.find((w) => w.id === id)?.name ?? "—") : "None";

  async function handleTogglePause(rule: ScheduleRule): Promise<void> {
    const nextStatus = rule.status === "paused" ? "active" : "paused";
    try {
      await fetchWithAuth(`${API_URL}/admin/schedule-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      refresh();
    } catch {
      showAlert("Failed to update schedule rule status.");
    }
  }

  async function handleDelete(rule: ScheduleRule): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/admin/schedule-rules/${rule.id}`, {
        method: "DELETE",
      });
      setDeleting(null);
      refresh();
    } catch {
      showAlert("Failed to delete schedule rule.");
    }
  }

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading schedule rules…</span>
      </div>
    );
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">Schedule Rules</h2>
          <p className="page-subtitle">
            Auto-create tickets on a recurring schedule.
          </p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            New Rule
          </Button>
        </div>
      </div>

      {rules.length === 0 ? (
        <div className="wfl-empty">
          <h4>No schedule rules yet</h4>
          <p>Create one to auto-create tickets on a recurring schedule.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Entity Type</TableHead>
              <TableHead>Workflow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Next Fire</TableHead>
              <TableHead style={{ width: 150 }}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.id}>
                <TableCell>
                  <Link to={`/admin/schedule-rules/${rule.id}`}>
                    {rule.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {rule.cronHuman ?? rule.cronExpr} ({rule.timezone})
                </TableCell>
                <TableCell>{entityTypeName(rule.entityTypeId)}</TableCell>
                <TableCell>{workflowName(rule.workflowId)}</TableCell>
                <TableCell>{rule.status}</TableCell>
                <TableCell>
                  {rule.nextFireAt
                    ? new Date(rule.nextFireAt).toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell>
                  <div style={{ display: "flex", gap: 6 }}>
                    <IconButton
                      aria-label={
                        rule.status === "paused" ? "Resume rule" : "Pause rule"
                      }
                      disabled={rule.status === "archived"}
                      onClick={() => void handleTogglePause(rule)}
                    >
                      {rule.status === "paused" ? "▶" : "⏸"}
                    </IconButton>
                    <IconButton
                      aria-label="Edit rule"
                      onClick={() => setEditing(rule)}
                    >
                      ✎
                    </IconButton>
                    <IconButton
                      aria-label="Delete rule"
                      onClick={() => setDeleting(rule)}
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

      <RuleFormModal
        open={creating}
        workflows={workflows}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          refresh();
        }}
      />
      <RuleFormModal
        open={editing !== null}
        rule={editing ?? undefined}
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
          <AlertDialogTitle>Delete schedule rule?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? `"${deleting.name}" will stop firing. Past executions remain visible in its history.`
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
    </div>
  );
}

interface RuleFormModalProps {
  open: boolean;
  rule?: ScheduleRule | undefined;
  workflows: WorkflowOption[];
  onClose: () => void;
  onSaved: () => void;
}

function RuleFormModal({
  open,
  rule,
  workflows,
  onClose,
  onSaved,
}: RuleFormModalProps): React.ReactElement {
  const { entityTypes } = useEntityTypes();
  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [cronExpr, setCronExpr] = useState(rule?.cronExpr ?? "0 9 * * 1");
  const [timezone, setTimezone] = useState(rule?.timezone ?? "UTC");
  const [entityTypeId, setEntityTypeId] = useState(rule?.entityTypeId ?? "");
  const [workflowId, setWorkflowId] = useState(rule?.workflowId ?? "");
  const [catchUp, setCatchUp] = useState(rule?.catchUp ?? false);
  const [templateTitle, setTemplateTitle] = useState(
    rule?.template.title ?? "",
  );
  const [templateDescription, setTemplateDescription] = useState(
    rule?.template.description ?? "",
  );
  const [templateSeverity, setTemplateSeverity] = useState(
    rule?.template.severity ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(rule?.name ?? "");
      setDescription(rule?.description ?? "");
      setCronExpr(rule?.cronExpr ?? "0 9 * * 1");
      setTimezone(rule?.timezone ?? "UTC");
      setEntityTypeId(rule?.entityTypeId ?? entityTypes[0]?.id ?? "");
      setWorkflowId(rule?.workflowId ?? "");
      setCatchUp(rule?.catchUp ?? false);
      setTemplateTitle(rule?.template.title ?? "");
      setTemplateDescription(rule?.template.description ?? "");
      setTemplateSeverity(rule?.template.severity ?? "");
      setError(null);
    }
  }, [open, rule, entityTypes]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Preserve fields this form has no control for (assignee_id/team_id/
      // service_id) from the existing rule -- rebuilding from scratch would
      // silently wipe them on every save (review finding).
      const template: ScheduleTemplate = {
        ...rule?.template,
        title: templateTitle,
        description: templateDescription || undefined,
        severity: (templateSeverity || undefined) as Severity | undefined,
      };
      const path = rule
        ? `${API_URL}/admin/schedule-rules/${rule.id}`
        : `${API_URL}/admin/schedule-rules`;
      const body: Record<string, unknown> = {
        name,
        description: description || undefined,
        cronExpr,
        timezone,
        workflowId: workflowId || undefined,
        catchUp,
        template,
      };
      if (!rule) body["entityTypeId"] = entityTypeId;
      await fetchWithAuth(path, {
        method: rule ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save rule");
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
      <DialogContent showCloseButton={false} style={{ maxWidth: 480 }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <DialogTitle asChild>
            <h2 className="page-title">
              {rule ? "Edit Schedule Rule" : "New Schedule Rule"}
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
            <label className="form-label">Name *</label>
            <input
              className="form-input"
              placeholder="e.g. Weekly Standup"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input
              className="form-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {!rule && (
            <div className="form-group">
              <label className="form-label">Entity Type *</label>
              <select
                className="form-input"
                value={entityTypeId}
                onChange={(e) => setEntityTypeId(e.target.value)}
                required
              >
                {entityTypes.map((et) => (
                  <option key={et.id} value={et.id}>
                    {et.plural}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Workflow</label>
            <select
              className="form-input"
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
            >
              <option value="">None</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Cron Expression *</label>
            <input
              className="form-input"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              required
            />
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 6,
              }}
            >
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="portal-btn-secondary"
                  style={{ padding: "3px 8px", fontSize: "11px" }}
                  onClick={() => setCronExpr(preset.expr)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Timezone *</label>
            <input
              className="form-input"
              placeholder="e.g. America/New_York"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
            />
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
                checked={catchUp}
                onChange={(e) => setCatchUp(e.target.checked)}
              />
              Catch up on missed fires (worker was down)
            </label>
          </div>

          <h3 className="page-title" style={{ fontSize: 14, marginTop: 20 }}>
            Ticket template
          </h3>
          <div className="form-group">
            <label className="form-label">Title *</label>
            <input
              className="form-input"
              placeholder="e.g. Weekly standup — {{date}}"
              value={templateTitle}
              onChange={(e) => setTemplateTitle(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input
              className="form-input"
              value={templateDescription}
              onChange={(e) => setTemplateDescription(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Severity</label>
            <select
              className="form-input"
              value={templateSeverity}
              onChange={(e) => setTemplateSeverity(e.target.value)}
            >
              <option value="">None</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <Button
            type="submit"
            variant="primary"
            disabled={saving}
            style={{ marginTop: 8 }}
          >
            {saving ? "Saving…" : rule ? "Save changes" : "Create rule"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
