import React, { useCallback, useEffect, useRef, useState } from "react";
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

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];
type RuleStatus = "active" | "paused" | "archived";
const DUE_DAYS_INTEGER_ERROR = "Due after (days) must be a whole number.";

// Cron expressions are still what the API stores and the worker reads
// (docs/decisions/ADR-017-temporal-scheduler.md: "cron as canonical
// format") -- this is purely a friendlier authoring surface over that same
// contract, for users who shouldn't need to know cron syntax. Only the 3
// shapes below are ever produced or parsed; anything else (a hand-written
// cron predating this UI, e.g. a quarterly preset) falls back to Daily
// with a best-effort time on edit.
type Frequency = "daily" | "weekly" | "monthly";

// Common IANA zones with a friendly label -- covers the tenants we support
// today without forcing every admin to know IANA identifiers. Not
// exhaustive: an existing rule's stored zone that isn't in this list (e.g.
// set before this picker existed, or a less-common zone) is added as an
// extra option on the fly so editing never silently changes it.
const TIMEZONE_OPTIONS = [
  { value: "UTC", label: "UTC" },
  { value: "Asia/Kolkata", label: "IST — India (Asia/Kolkata)" },
  { value: "America/New_York", label: "ET — US Eastern (America/New_York)" },
  { value: "America/Chicago", label: "CT — US Central (America/Chicago)" },
  { value: "America/Denver", label: "MT — US Mountain (America/Denver)" },
  {
    value: "America/Los_Angeles",
    label: "PT — US Pacific (America/Los_Angeles)",
  },
  { value: "Europe/London", label: "UK — London (Europe/London)" },
  { value: "Europe/Paris", label: "CET — Paris/Berlin (Europe/Paris)" },
  { value: "Asia/Dubai", label: "GST — Dubai (Asia/Dubai)" },
  { value: "Asia/Singapore", label: "SGT — Singapore (Asia/Singapore)" },
  { value: "Asia/Shanghai", label: "CST — China (Asia/Shanghai)" },
  { value: "Asia/Tokyo", label: "JST — Japan (Asia/Tokyo)" },
  {
    value: "Australia/Sydney",
    label: "AEST/AEDT — Sydney (Australia/Sydney)",
  },
] as const;

const WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function buildCronExpr(
  frequency: Frequency,
  timeOfDay: string,
  dayOfWeek: number,
  dayOfMonth: number,
): string {
  const [hourStr, minuteStr] = timeOfDay.split(":");
  const hour = Number(hourStr ?? 9);
  const minute = Number(minuteStr ?? 0);
  if (frequency === "weekly") return `${minute} ${hour} * * ${dayOfWeek}`;
  if (frequency === "monthly") return `${minute} ${hour} ${dayOfMonth} * *`;
  return `${minute} ${hour} * * *`;
}

function parseCronToFrequency(cronExpr: string): {
  frequency: Frequency;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
} {
  const fallback = {
    frequency: "daily" as Frequency,
    timeOfDay: "09:00",
    dayOfWeek: 1,
    dayOfMonth: 1,
  };
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [minStr, hourStr, dom, , dow] = parts;
  const minute = Number(minStr);
  const hour = Number(hourStr);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return fallback;
  const timeOfDay = `${pad2(hour)}:${pad2(minute)}`;
  if (dom !== "*" && /^\d+$/.test(dom ?? "")) {
    return {
      frequency: "monthly",
      timeOfDay,
      dayOfWeek: 1,
      dayOfMonth: Number(dom),
    };
  }
  if (dow !== "*" && /^\d+$/.test(dow ?? "")) {
    return {
      frequency: "weekly",
      timeOfDay,
      dayOfWeek: Number(dow),
      dayOfMonth: 1,
    };
  }
  return { ...fallback, timeOfDay };
}

// Generic searchable, single-select dropdown -- same click-outside/search-
// box/clear-button pattern as record-create.tsx's UserPicker/TeamPicker,
// factored out here as a reusable primitive rather than a copy-paste (this
// page needs the same UX for Workflow, not just User/Team).
function useOutsideClick(
  ref: React.RefObject<HTMLElement>,
  onOutside: () => void,
): void {
  useEffect(() => {
    function handler(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onOutside();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onOutside]);
}

function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  emptyLabel,
  allowClear,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  emptyLabel: string;
  allowClear?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  useOutsideClick(
    ref,
    useCallback(() => {
      setOpen(false);
      setQuery("");
    }, []),
  );

  function handleOpen(): void {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSelect(id: string): void {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={handleOpen}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 12px",
          background: "var(--bg-primary)",
          border: "1.5px solid var(--border-primary)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          textAlign: "left",
          color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
          fontSize: 14,
        }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected ? selected.label : placeholder}
        </span>
        {allowClear && selected && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            style={{
              color: "var(--text-tertiary)",
              fontSize: 16,
              lineHeight: 1,
              cursor: "pointer",
              padding: "2px 4px",
            }}
            title="Clear"
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            background: "var(--bg-primary)",
            border: "1.5px solid var(--border-primary)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 50,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: 8,
              borderBottom: "1px solid var(--border-primary)",
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "7px 10px",
                border: "1.5px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)",
                fontSize: 13,
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {allowClear && (
              <div
                onClick={() => handleSelect("")}
                style={{
                  padding: "9px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--text-tertiary)",
                  fontStyle: "italic",
                }}
              >
                {emptyLabel}
              </div>
            )}
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: 12,
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: 13,
                }}
              >
                No results
              </div>
            ) : (
              filtered.map((o) => (
                <div
                  key={o.id}
                  onClick={() => handleSelect(o.id)}
                  style={{
                    padding: "9px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: o.id === value ? 600 : 400,
                    color:
                      o.id === value
                        ? "var(--accent-primary)"
                        : "var(--text-primary)",
                    background:
                      o.id === value ? "var(--bg-secondary)" : "transparent",
                  }}
                >
                  {o.label}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface WorkflowOption {
  id: string;
  name: string;
}

interface UserOption {
  userId: string;
  displayName: string;
}

interface TeamOption {
  id: string;
  name: string;
}

export interface ScheduleTemplate {
  title: string;
  description?: string | undefined;
  severity?: Severity | undefined;
  // Mandate fields mirror record-create.tsx's ticket-creation form
  // (docs/specs/schedule-rules-mandate-fields.md) -- exactly one of
  // assignedTo/teamId, due_days is an offset from each fire's own scheduled
  // instant (no fixed date makes sense for a recurring rule), remark
  // becomes the fired ticket's first comment.
  assignedTo?: string | undefined;
  teamId?: string | undefined;
  service_id?: string | undefined;
  due_days: number;
  remark: string;
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
  const [rules, setRules] = useState<ScheduleRule[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduleRule | null>(null);
  const [deleting, setDeleting] = useState<ScheduleRule | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/schedule-rules`),
      fetchWithAuth(`${API_URL}/workflows`),
      fetchWithAuth(`${API_URL}/users`),
      fetchWithAuth(`${API_URL}/admin/teams`),
    ])
      .then(([rulesRes, workflowsRes, usersRes, teamsRes]) => {
        setRules((rulesRes as { data: ScheduleRule[] }).data);
        setWorkflows((workflowsRes as { data?: WorkflowOption[] }).data ?? []);
        setUsers((usersRes as { data?: UserOption[] }).data ?? []);
        setTeams((teamsRes as { data?: TeamOption[] }).data ?? []);
      })
      .catch(() => showAlert("Failed to load schedule rules."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
        users={users}
        teams={teams}
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
        users={users}
        teams={teams}
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
  users: UserOption[];
  teams: TeamOption[];
  onClose: () => void;
  onSaved: () => void;
}

function RuleFormModal({
  open,
  rule,
  workflows,
  users,
  teams,
  onClose,
  onSaved,
}: RuleFormModalProps): React.ReactElement {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const initialFreq = parseCronToFrequency(rule?.cronExpr ?? "0 9 * * *");
  const [frequency, setFrequency] = useState<Frequency>(initialFreq.frequency);
  const [timeOfDay, setTimeOfDay] = useState(initialFreq.timeOfDay);
  const [dayOfWeek, setDayOfWeek] = useState(initialFreq.dayOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(initialFreq.dayOfMonth);
  const [timezone, setTimezone] = useState(rule?.timezone ?? "UTC");
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
  // Exactly one of assignedTo/teamId, same contract as record-create.tsx's
  // ticket-creation form (docs/specs/schedule-rules-mandate-fields.md R1) --
  // teamId is only ever sent when mode is "team" and vice versa, regardless
  // of which mode was last touched.
  const [assignMode, setAssignMode] = useState<"user" | "team">(
    rule?.template.assignedTo ? "user" : "team",
  );
  const [assignedTo, setAssignedTo] = useState(rule?.template.assignedTo ?? "");
  const [teamId, setTeamId] = useState(rule?.template.teamId ?? "");
  const [dueDays, setDueDays] = useState(
    rule?.template.due_days !== undefined ? String(rule.template.due_days) : "",
  );
  const [remark, setRemark] = useState(rule?.template.remark ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep(1);
      setName(rule?.name ?? "");
      setDescription(rule?.description ?? "");
      const freq = parseCronToFrequency(rule?.cronExpr ?? "0 9 * * *");
      setFrequency(freq.frequency);
      setTimeOfDay(freq.timeOfDay);
      setDayOfWeek(freq.dayOfWeek);
      setDayOfMonth(freq.dayOfMonth);
      setTimezone(rule?.timezone ?? "UTC");
      setWorkflowId(rule?.workflowId ?? "");
      setCatchUp(rule?.catchUp ?? false);
      setTemplateTitle(rule?.template.title ?? "");
      setTemplateDescription(rule?.template.description ?? "");
      setTemplateSeverity(rule?.template.severity ?? "");
      setAssignMode(rule?.template.assignedTo ? "user" : "team");
      setAssignedTo(rule?.template.assignedTo ?? "");
      setTeamId(rule?.template.teamId ?? "");
      setDueDays(
        rule?.template.due_days !== undefined
          ? String(rule.template.due_days)
          : "",
      );
      setRemark(rule?.template.remark ?? "");
      setError(null);
    }
  }, [open, rule]);

  function handleNext(e: React.FormEvent): void {
    e.preventDefault();
    if (!name.trim() || !timeOfDay) {
      setError("Name and time of day are required.");
      return;
    }
    setError(null);
    setStep(2);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const assignValue = assignMode === "user" ? assignedTo : teamId;
    if (!assignValue || !dueDays || !remark.trim()) {
      setError(
        assignMode === "user"
          ? "Assignee, due date, and remark are required."
          : "Team, due date, and remark are required.",
      );
      return;
    }
    const dueDaysValue = Number(dueDays);
    if (!Number.isInteger(dueDaysValue)) {
      setError(DUE_DAYS_INTEGER_ERROR);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Preserve fields this form has no control for (service_id) from the
      // existing rule -- rebuilding from scratch would silently wipe it on
      // every save (review finding this form's assignee/team fields had
      // the same issue with before this pass).
      const template: ScheduleTemplate = {
        ...rule?.template,
        title: templateTitle,
        description: templateDescription || undefined,
        severity: (templateSeverity || undefined) as Severity | undefined,
        assignedTo: assignMode === "user" ? assignedTo : undefined,
        teamId: assignMode === "team" ? teamId : undefined,
        due_days: dueDaysValue,
        remark: remark.trim(),
      };
      const cronExpr = buildCronExpr(
        frequency,
        timeOfDay,
        dayOfWeek,
        dayOfMonth,
      );
      const path = rule
        ? `${API_URL}/admin/schedule-rules/${rule.id}`
        : `${API_URL}/admin/schedule-rules`;
      // entityTypeId deliberately omitted -- schedule rules only ever
      // create tickets, so the server resolves the tenant's "ticket" entity
      // type itself (docs/tracker/week-log/2026-09-22-schedule-rules-
      // mandate-fields.md's entityTypeId incident) rather than trusting a
      // client-side lookup against a possibly-paginated entity-types list.
      const body: Record<string, unknown> = {
        name,
        description: description || undefined,
        cronExpr,
        timezone,
        workflowId: workflowId || undefined,
        catchUp,
        template,
      };
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
      <DialogContent showCloseButton={false} style={{ maxWidth: 520 }}>
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

        <StepIndicator step={step} />

        {error && (
          <div className="alert alert-error" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        {step === 1 ? (
          <form onSubmit={handleNext}>
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
            <div className="form-group">
              <label className="form-label">Workflow</label>
              <SearchableSelect
                options={workflows.map((w) => ({ id: w.id, label: w.name }))}
                value={workflowId}
                onChange={setWorkflowId}
                placeholder="Search and select a workflow…"
                emptyLabel="None"
                allowClear
              />
            </div>

            <div className="form-group">
              <label className="form-label">Repeats *</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {(["daily", "weekly", "monthly"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="portal-btn-secondary"
                    style={{
                      padding: "5px 14px",
                      fontWeight: 600,
                      textTransform: "capitalize",
                      background:
                        frequency === f
                          ? "var(--accent-primary)"
                          : "var(--bg-primary)",
                      color: frequency === f ? "#fff" : "var(--text-primary)",
                    }}
                    onClick={() => setFrequency(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                {frequency === "weekly" && (
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <label className="form-label" htmlFor="rule-day-of-week">
                      Day
                    </label>
                    <select
                      id="rule-day-of-week"
                      className="form-input"
                      value={dayOfWeek}
                      onChange={(e) => setDayOfWeek(Number(e.target.value))}
                    >
                      {WEEKDAY_OPTIONS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {frequency === "monthly" && (
                  <div style={{ flex: 1, minWidth: 100 }}>
                    <label className="form-label" htmlFor="rule-day-of-month">
                      Day of month
                    </label>
                    <input
                      id="rule-day-of-month"
                      className="form-input"
                      type="number"
                      min={1}
                      max={31}
                      value={dayOfMonth}
                      onChange={(e) => setDayOfMonth(Number(e.target.value))}
                    />
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label className="form-label" htmlFor="rule-time-of-day">
                    Time
                  </label>
                  <input
                    id="rule-time-of-day"
                    className="form-input"
                    type="time"
                    value={timeOfDay}
                    onChange={(e) => setTimeOfDay(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="rule-timezone">
                Timezone *
              </label>
              <select
                id="rule-timezone"
                className="form-input"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                required
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
                {!TIMEZONE_OPTIONS.some((tz) => tz.value === timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
              </select>
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

            <Button type="submit" variant="primary" style={{ marginTop: 8 }}>
              Next: Ticket template →
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)}>
            <div className="form-group">
              <label className="form-label">Title *</label>
              <input
                className="form-input"
                placeholder="e.g. Weekly standup — {{date}}"
                value={templateTitle}
                autoFocus
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

            <div className="form-group">
              <label className="form-label">Assign To *</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button
                  type="button"
                  className="portal-btn-secondary"
                  style={{
                    padding: "5px 12px",
                    fontWeight: 600,
                    background:
                      assignMode === "user"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      assignMode === "user" ? "#fff" : "var(--text-primary)",
                  }}
                  onClick={() => setAssignMode("user")}
                >
                  User
                </button>
                <button
                  type="button"
                  className="portal-btn-secondary"
                  style={{
                    padding: "5px 12px",
                    fontWeight: 600,
                    background:
                      assignMode === "team"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      assignMode === "team" ? "#fff" : "var(--text-primary)",
                  }}
                  onClick={() => setAssignMode("team")}
                >
                  Team
                </button>
              </div>
              {assignMode === "user" ? (
                <select
                  className="form-input"
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                  required
                >
                  <option value="">Select a user…</option>
                  {users.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.displayName}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="form-input"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  required
                >
                  <option value="">Select a team…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              {assignMode === "team" && (
                <p className="page-subtitle" style={{ marginTop: 6 }}>
                  Resolves to the team's on-call primary at fire time (falling
                  back to backup, escalation manager, then workflow admin).
                </p>
              )}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="rule-due-days">
                Due — days after creation *
              </label>
              <input
                id="rule-due-days"
                className="form-input"
                type="number"
                step={1}
                min={0}
                max={3650}
                value={dueDays}
                onChange={(e) => {
                  const value = e.target.value;
                  setDueDays(value);
                  if (value !== "" && !Number.isInteger(Number(value))) {
                    setError(DUE_DAYS_INTEGER_ERROR);
                  } else if (error === DUE_DAYS_INTEGER_ERROR) {
                    setError(null);
                  }
                }}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="rule-remark">
                Remark *
              </label>
              <p className="page-subtitle" style={{ marginTop: 0 }}>
                Posted as the created ticket's first comment.
              </p>
              <textarea
                id="rule-remark"
                className="form-input"
                rows={3}
                maxLength={4000}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                required
              />
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setStep(1)}
              >
                ← Back
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "Saving…" : rule ? "Save changes" : "Create rule"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: 1 | 2 }): React.ReactElement {
  const steps: { n: 1 | 2; label: string }[] = [
    { n: 1, label: "Scheduling" },
    { n: 2, label: "Ticket template" },
  ];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 14,
        marginBottom: 4,
      }}
    >
      {steps.map((s, i) => (
        <React.Fragment key={s.n}>
          {i > 0 && (
            <div
              style={{
                flex: 1,
                height: 2,
                background:
                  step > s.n - 1
                    ? "var(--accent-primary)"
                    : "var(--border-primary)",
              }}
            />
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              fontWeight: 600,
              color: step === s.n ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                borderRadius: "50%",
                fontSize: 11,
                background:
                  step >= s.n ? "var(--accent-primary)" : "var(--bg-secondary)",
                color: step >= s.n ? "#fff" : "var(--text-muted)",
              }}
            >
              {s.n}
            </span>
            {s.label}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
