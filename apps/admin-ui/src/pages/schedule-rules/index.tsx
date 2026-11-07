import { Trans, useTranslation } from "react-i18next";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
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
import {
  CircleActionButton,
  EditIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
} from "../../components/action-icons.js";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { useOutsideClick } from "../../hooks/use-outside-click.js";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITIES)[number];
type RuleStatus = "active" | "paused" | "archived";
const DUE_DAYS_ERROR_KEY = "scheduleRules.dueDaysIntegerError";

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
// New rules default to India time; an existing rule keeps whatever zone it was saved with.
const DEFAULT_TIMEZONE = "Asia/Kolkata";

const TIMEZONE_OPTIONS = [
  { value: "UTC", labelKey: "scheduleRules.tz.UTC" },
  { value: "Asia/Kolkata", labelKey: "scheduleRules.tz.Asia_Kolkata" },
  { value: "America/New_York", labelKey: "scheduleRules.tz.America_New_York" },
  { value: "America/Chicago", labelKey: "scheduleRules.tz.America_Chicago" },
  { value: "America/Denver", labelKey: "scheduleRules.tz.America_Denver" },
  {
    value: "America/Los_Angeles",
    labelKey: "scheduleRules.tz.America_Los_Angeles",
  },
  { value: "Europe/London", labelKey: "scheduleRules.tz.Europe_London" },
  { value: "Europe/Paris", labelKey: "scheduleRules.tz.Europe_Paris" },
  { value: "Asia/Dubai", labelKey: "scheduleRules.tz.Asia_Dubai" },
  { value: "Asia/Singapore", labelKey: "scheduleRules.tz.Asia_Singapore" },
  { value: "Asia/Shanghai", labelKey: "scheduleRules.tz.Asia_Shanghai" },
  { value: "Asia/Tokyo", labelKey: "scheduleRules.tz.Asia_Tokyo" },
  { value: "Australia/Sydney", labelKey: "scheduleRules.tz.Australia_Sydney" },
] as const;

const WEEKDAY_OPTIONS = [
  { value: 0, labelKey: "scheduleRules.weekdays.sunday" },
  { value: 1, labelKey: "scheduleRules.weekdays.monday" },
  { value: 2, labelKey: "scheduleRules.weekdays.tuesday" },
  { value: 3, labelKey: "scheduleRules.weekdays.wednesday" },
  { value: 4, labelKey: "scheduleRules.weekdays.thursday" },
  { value: 5, labelKey: "scheduleRules.weekdays.friday" },
  { value: 6, labelKey: "scheduleRules.weekdays.saturday" },
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

function isCronRepresentableByPicker(cronExpr: string): boolean {
  const parsed = parseCronToFrequency(cronExpr);
  const [hourStr, minuteStr] = parsed.timeOfDay.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  // Required, not redundant: the round-trip check below accepts out-of-range
  // integers (e.g. "0 25 * * *" rebuilds byte-for-byte), so these bounds are
  // what reject them.
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  if (
    parsed.frequency === "weekly" &&
    (parsed.dayOfWeek < 0 || parsed.dayOfWeek > 6)
  ) {
    return false;
  }
  if (
    parsed.frequency === "monthly" &&
    (parsed.dayOfMonth < 1 || parsed.dayOfMonth > 31)
  ) {
    return false;
  }
  return (
    buildCronExpr(
      parsed.frequency,
      parsed.timeOfDay,
      parsed.dayOfWeek,
      parsed.dayOfMonth,
    ) === cronExpr.trim()
  );
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
  const { t } = useTranslation();
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
            title={t("scheduleRules.clear")}
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
              placeholder={t("scheduleRules.searchPlaceholder")}
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
                {t("scheduleRules.noResults")}
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
  const { t } = useTranslation();
  const [rules, setRules] = useState<ScheduleRule[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ScheduleRule | null>(null);
  const [deleting, setDeleting] = useState<ScheduleRule | null>(null);
  const [pausing, setPausing] = useState<ScheduleRule | null>(null);

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
      .catch(() => showAlert(t("scheduleRules.failedToLoad")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const workflowName = (id: string | null): string =>
    id
      ? (workflows.find((w) => w.id === id)?.name ?? "—")
      : t("scheduleRules.none");

  async function handleTogglePause(rule: ScheduleRule): Promise<void> {
    const nextStatus = rule.status === "paused" ? "active" : "paused";
    setPausing(null);
    try {
      await fetchWithAuth(`${API_URL}/admin/schedule-rules/${rule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      refresh();
    } catch {
      showAlert(t("scheduleRules.failedToUpdateStatus"));
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
      showAlert(t("scheduleRules.failedToDelete"));
    }
  }

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">{t("scheduleRules.loading")}</span>
      </div>
    );
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">{t("scheduleRules.title")}</h2>
          <p className="page-subtitle">{t("scheduleRules.subtitle")}</p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t("scheduleRules.newRule")}
          </Button>
        </div>
      </div>

      {rules.length === 0 ? (
        <div className="wfl-empty">
          <h4>{t("scheduleRules.noRules")}</h4>
          <p>{t("scheduleRules.noRulesDesc")}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("scheduleRules.name")}</TableHead>
              <TableHead>{t("scheduleRules.schedule")}</TableHead>
              <TableHead>{t("scheduleRules.workflow")}</TableHead>
              <TableHead>{t("scheduleRules.status")}</TableHead>
              <TableHead>{t("scheduleRules.nextFire")}</TableHead>
              <TableHead style={{ width: 150 }}>
                {t("scheduleRules.actions")}
              </TableHead>
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
                <TableCell>
                  {t(`scheduleRules.statusValue.${rule.status}`)}
                </TableCell>
                <TableCell>
                  {rule.nextFireAt
                    ? new Date(rule.nextFireAt).toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell>
                  <div style={{ display: "flex", gap: 6 }}>
                    <CircleActionButton
                      size={30}
                      color={rule.status === "paused" ? "green" : "yellow"}
                      label={
                        rule.status === "paused"
                          ? t("scheduleRules.resumeRule")
                          : t("scheduleRules.pauseRule")
                      }
                      icon={
                        rule.status === "paused" ? (
                          <PlayIcon size={14} />
                        ) : (
                          <PauseIcon size={14} />
                        )
                      }
                      disabled={rule.status === "archived"}
                      onClick={() =>
                        rule.status === "paused"
                          ? void handleTogglePause(rule)
                          : setPausing(rule)
                      }
                    />
                    <CircleActionButton
                      size={30}
                      color="grey"
                      label={t("scheduleRules.editRule")}
                      icon={<EditIcon size={14} />}
                      onClick={() => setEditing(rule)}
                    />
                    <CircleActionButton
                      size={30}
                      color="red"
                      label={t("scheduleRules.deleteRule")}
                      icon={<TrashIcon size={14} />}
                      onClick={() => setDeleting(rule)}
                    />
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
        open={pausing !== null}
        onOpenChange={(next) => {
          if (!next) setPausing(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t("scheduleRules.pauseTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {pausing
              ? t(
                  pausing.catchUp
                    ? "scheduleRules.pauseDescCatchUp"
                    : "scheduleRules.pauseDescSkip",
                  { name: pausing.name },
                )
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("scheduleRules.keepRunning")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pausing && void handleTogglePause(pausing)}
            >
              {t("scheduleRules.pauseRule")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t("scheduleRules.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? t("scheduleRules.deleteDesc", { name: deleting.name })
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("scheduleRules.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && void handleDelete(deleting)}
            >
              {t("scheduleRules.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export interface RuleFormData {
  step: 1 | 2;
  name: string;
  description: string;
  frequency: Frequency;
  timeOfDay: string;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
  workflowId: string;
  catchUp: boolean;
  templateTitle: string;
  templateDescription: string;
  templateSeverity: string;
  assignMode: "user" | "team";
  assignedTo: string;
  teamId: string;
  dueDays: string;
  remark: string;
}

export function initialRuleFormData(rule?: ScheduleRule): RuleFormData {
  const freq = parseCronToFrequency(rule?.cronExpr ?? "0 9 * * *");
  return {
    step: 1,
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    frequency: freq.frequency,
    timeOfDay: freq.timeOfDay,
    dayOfWeek: freq.dayOfWeek,
    dayOfMonth: freq.dayOfMonth,
    timezone: rule?.timezone ?? DEFAULT_TIMEZONE,
    workflowId: rule?.workflowId ?? "",
    catchUp: rule?.catchUp ?? false,
    templateTitle: rule?.template.title ?? "",
    templateDescription: rule?.template.description ?? "",
    templateSeverity: rule?.template.severity ?? "",
    // Exactly one of assignedTo/teamId, same contract as record-create.tsx's
    // ticket-creation form (docs/specs/schedule-rules-mandate-fields.md R1) --
    // teamId is only ever sent when mode is "team" and vice versa, regardless
    // of which mode was last touched.
    assignMode: rule?.template.assignedTo ? "user" : "team",
    assignedTo: rule?.template.assignedTo ?? "",
    teamId: rule?.template.teamId ?? "",
    dueDays:
      rule?.template.due_days !== undefined
        ? String(rule.template.due_days)
        : "",
    remark: rule?.template.remark ?? "",
  };
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
  const { t } = useTranslation();
  const [formData, setFormData] = useState<RuleFormData>(() =>
    initialRuleFormData(rule),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsupportedCronExpr =
    rule && !isCronRepresentableByPicker(rule.cronExpr) ? rule.cronExpr : null;

  useEffect(() => {
    if (open) {
      setFormData(initialRuleFormData(rule));
      setError(null);
    }
  }, [open, rule]);

  function updateField<K extends keyof RuleFormData>(
    key: K,
    val: RuleFormData[K],
  ): void {
    setFormData((prev) => ({ ...prev, [key]: val }));
  }

  function handleNext(e: React.FormEvent): void {
    e.preventDefault();
    if (!formData.name.trim() || !formData.timeOfDay) {
      setError(t("scheduleRules.nameRequired"));
      return;
    }
    setError(null);
    updateField("step", 2);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const assignValue =
      formData.assignMode === "user" ? formData.assignedTo : formData.teamId;
    if (!assignValue || !formData.dueDays || !formData.remark.trim()) {
      setError(
        formData.assignMode === "user"
          ? t("scheduleRules.assigneeRequired")
          : t("scheduleRules.teamRequired"),
      );
      return;
    }
    const dueDaysValue = Number(formData.dueDays);
    if (
      !Number.isInteger(dueDaysValue) ||
      dueDaysValue < 0 ||
      dueDaysValue > 3650
    ) {
      setError(t(DUE_DAYS_ERROR_KEY));
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
        title: formData.templateTitle,
        description: formData.templateDescription || undefined,
        severity: (formData.templateSeverity || undefined) as
          | Severity
          | undefined,
        assignedTo:
          formData.assignMode === "user" ? formData.assignedTo : undefined,
        teamId: formData.assignMode === "team" ? formData.teamId : undefined,
        due_days: dueDaysValue,
        remark: formData.remark.trim(),
      };
      const cronExpr = buildCronExpr(
        formData.frequency,
        formData.timeOfDay,
        formData.dayOfWeek,
        formData.dayOfMonth,
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
        name: formData.name,
        description: formData.description || undefined,
        cronExpr,
        timezone: formData.timezone,
        workflowId: formData.workflowId || undefined,
        catchUp: formData.catchUp,
        template,
      };
      await fetchWithAuth(path, {
        method: rule ? "PATCH" : "POST",
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("scheduleRules.failedToSave"),
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
              {rule
                ? t("scheduleRules.editTitle")
                : t("scheduleRules.newTitle")}
            </h2>
          </DialogTitle>
          <DialogClose asChild>
            <button
              type="button"
              aria-label={t("scheduleRules.close")}
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

        <StepIndicator step={formData.step} />

        {error && (
          <div className="alert alert-error" style={{ marginTop: 16 }}>
            {error}
          </div>
        )}

        {formData.step === 1 ? (
          <form onSubmit={handleNext}>
            {unsupportedCronExpr && (
              <div className="form-group">
                <div className="alert alert-warning" role="alert">
                  <Trans
                    i18nKey="scheduleRules.unsupportedCron"
                    values={{ cron: unsupportedCronExpr }}
                    components={{ code: <code /> }}
                  />
                </div>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.nameLabel")}
              </label>
              <input
                className="form-input"
                placeholder={t("scheduleRules.namePlaceholder")}
                value={formData.name}
                autoFocus
                onChange={(e) => updateField("name", e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.description")}
              </label>
              <input
                className="form-input"
                value={formData.description}
                onChange={(e) => updateField("description", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.workflow")}
              </label>
              <SearchableSelect
                options={workflows.map((w) => ({ id: w.id, label: w.name }))}
                value={formData.workflowId}
                onChange={(val) => updateField("workflowId", val)}
                placeholder={t("scheduleRules.workflowPlaceholder")}
                emptyLabel={t("scheduleRules.none")}
                allowClear
              />
            </div>

            <div className="form-group">
              <label className="form-label">{t("scheduleRules.repeats")}</label>
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
                        formData.frequency === f
                          ? "var(--accent-primary)"
                          : "var(--bg-primary)",
                      color:
                        formData.frequency === f
                          ? "#fff"
                          : "var(--text-primary)",
                    }}
                    onClick={() => updateField("frequency", f)}
                  >
                    {t(`scheduleRules.frequencyValue.${f}`)}
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
                {formData.frequency === "weekly" && (
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <label className="form-label" htmlFor="rule-day-of-week">
                      {t("scheduleRules.day")}
                    </label>
                    <select
                      id="rule-day-of-week"
                      className="form-input"
                      value={formData.dayOfWeek}
                      onChange={(e) =>
                        updateField("dayOfWeek", Number(e.target.value))
                      }
                    >
                      {WEEKDAY_OPTIONS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {t(d.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {formData.frequency === "monthly" && (
                  <div style={{ flex: 1, minWidth: 100 }}>
                    <label className="form-label" htmlFor="rule-day-of-month">
                      {t("scheduleRules.dayOfMonth")}
                    </label>
                    <input
                      id="rule-day-of-month"
                      className="form-input"
                      type="number"
                      min={1}
                      max={31}
                      value={formData.dayOfMonth}
                      onChange={(e) =>
                        updateField("dayOfMonth", Number(e.target.value))
                      }
                    />
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label className="form-label" htmlFor="rule-time-of-day">
                    {t("scheduleRules.time")}
                  </label>
                  <input
                    id="rule-time-of-day"
                    className="form-input"
                    type="time"
                    value={formData.timeOfDay}
                    onChange={(e) => updateField("timeOfDay", e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="rule-timezone">
                {t("scheduleRules.timezoneLabel")}
              </label>
              <select
                id="rule-timezone"
                className="form-input"
                value={formData.timezone}
                onChange={(e) => updateField("timezone", e.target.value)}
                required
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {t(tz.labelKey)}
                  </option>
                ))}
                {!TIMEZONE_OPTIONS.some(
                  (tz) => tz.value === formData.timezone,
                ) && (
                  <option value={formData.timezone}>{formData.timezone}</option>
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
                  checked={formData.catchUp}
                  onChange={(e) => updateField("catchUp", e.target.checked)}
                />
                {t("scheduleRules.catchUp")}
              </label>
              {rule && !rule.catchUp && formData.catchUp && (
                <div
                  role="alert"
                  className="alert alert-warning"
                  style={{ marginTop: 8 }}
                >
                  {t("scheduleRules.catchUpWarning")}
                </div>
              )}
            </div>

            <Button type="submit" variant="primary" style={{ marginTop: 8 }}>
              {t("scheduleRules.nextTemplate")}
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)}>
            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.titleLabel")}
              </label>
              <input
                className="form-input"
                placeholder={t("scheduleRules.titleTemplatePlaceholder")}
                value={formData.templateTitle}
                autoFocus
                onChange={(e) => updateField("templateTitle", e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.description")}
              </label>
              <input
                className="form-input"
                value={formData.templateDescription}
                onChange={(e) =>
                  updateField("templateDescription", e.target.value)
                }
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.severity")}
              </label>
              <select
                className="form-input"
                value={formData.templateSeverity}
                onChange={(e) =>
                  updateField("templateSeverity", e.target.value)
                }
              >
                <option value="">{t("scheduleRules.none")}</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`scheduleRules.severityValue.${s}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">
                {t("scheduleRules.assignTo")}
              </label>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button
                  type="button"
                  className="portal-btn-secondary"
                  style={{
                    padding: "5px 12px",
                    fontWeight: 600,
                    background:
                      formData.assignMode === "user"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      formData.assignMode === "user"
                        ? "#fff"
                        : "var(--text-primary)",
                  }}
                  onClick={() => updateField("assignMode", "user")}
                >
                  {t("scheduleRules.user")}
                </button>
                <button
                  type="button"
                  className="portal-btn-secondary"
                  style={{
                    padding: "5px 12px",
                    fontWeight: 600,
                    background:
                      formData.assignMode === "team"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      formData.assignMode === "team"
                        ? "#fff"
                        : "var(--text-primary)",
                  }}
                  onClick={() => updateField("assignMode", "team")}
                >
                  {t("scheduleRules.team")}
                </button>
              </div>
              {formData.assignMode === "user" ? (
                <select
                  className="form-input"
                  value={formData.assignedTo}
                  onChange={(e) => updateField("assignedTo", e.target.value)}
                  required
                >
                  <option value="">{t("scheduleRules.selectUser")}</option>
                  {users.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.displayName}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="form-input"
                  value={formData.teamId}
                  onChange={(e) => updateField("teamId", e.target.value)}
                  required
                >
                  <option value="">{t("scheduleRules.selectTeam")}</option>
                  {teams.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                    </option>
                  ))}
                </select>
              )}
              {formData.assignMode === "team" && (
                <p className="page-subtitle" style={{ marginTop: 6 }}>
                  {t("scheduleRules.teamResolveHint")}
                </p>
              )}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="rule-due-days">
                {t("scheduleRules.dueDaysLabel")}
              </label>
              <input
                id="rule-due-days"
                className="form-input"
                type="number"
                step={1}
                min={0}
                max={3650}
                value={formData.dueDays}
                onChange={(e) => {
                  const value = e.target.value;
                  updateField("dueDays", value);
                  const numericValue = Number(value);
                  if (
                    value !== "" &&
                    (!Number.isInteger(numericValue) ||
                      numericValue < 0 ||
                      numericValue > 3650)
                  ) {
                    setError(t(DUE_DAYS_ERROR_KEY));
                  } else if (error === t(DUE_DAYS_ERROR_KEY)) {
                    setError(null);
                  }
                }}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="rule-remark">
                {t("scheduleRules.remarkLabel")}
              </label>
              <p className="page-subtitle" style={{ marginTop: 0 }}>
                {t("scheduleRules.remarkHint")}
              </p>
              <textarea
                id="rule-remark"
                className="form-input"
                rows={3}
                maxLength={4000}
                value={formData.remark}
                onChange={(e) => updateField("remark", e.target.value)}
                required
              />
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => updateField("step", 1)}
              >
                {t("scheduleRules.back")}
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving
                  ? t("scheduleRules.saving")
                  : rule
                    ? t("scheduleRules.saveChanges")
                    : t("scheduleRules.createRuleButton")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: 1 | 2 }): React.ReactElement {
  const { t } = useTranslation();
  const steps: { n: 1 | 2; label: string }[] = [
    { n: 1, label: t("scheduleRules.stepScheduling") },
    { n: 2, label: t("scheduleRules.stepTemplate") },
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
