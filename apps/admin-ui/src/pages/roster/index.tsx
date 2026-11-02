import { useTranslation } from "react-i18next";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { UserPicker } from "../../components/user-picker.js";
import { avatarColor } from "../../lib/theme.js";
import { useModal } from "../../hooks/use-modal.js";
import type { Team } from "../teams/index.js";

interface TenantUser {
  userId: string;
  displayName: string;
  email: string;
  loginName?: string;
}

interface OnCallSchedule {
  id: string;
  teamId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  primaryUserId: string;
  backupUserId: string | null;
  escalationManagerUserId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday-anchored start of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - diff);
  return monday;
}

/**
 * Roster — visual weekly on-call coverage per team (docs/specs/oncall-
 * routing.md T18). No third-party calendar library: a lightweight 7-column
 * CSS grid where each on_call_schedules row renders as a bar spanning the
 * days it overlaps this week, color-coded by primary user. Backed by
 * GET /admin/on-call-schedules?teamId&from&to.
 */
export function RosterPage(): React.ReactElement {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeek(new Date()),
  );
  const [schedules, setSchedules] = useState<OnCallSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  // The list route has no total count in its response, so an exact-limit
  // result is the only signal available that more rows may exist beyond the
  // page (PR #602 review, M3) -- not a precise "there are N more", just a
  // heuristic warning rather than silently showing an incomplete week.
  const [possiblyTruncated, setPossiblyTruncated] = useState(false);
  const createModal = useModal();
  const editModal = useModal<OnCallSchedule>();
  const deleteModal = useModal<OnCallSchedule>();

  useEffect(() => {
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/teams`),
      // Admin-only endpoint for on-call assignee pickers (PR #602 review,
      // BLOCKER-1) -- separate from GET /users, the @mention picker. Returns
      // admin, agent and "user" (employee) members.
      fetchWithAuth(`${API_URL}/admin/members`),
    ])
      .then(([teamsRes, usersRes]) => {
        const teamRows = (teamsRes as { data: Team[] }).data;
        setTeams(teamRows);
        setUsers((usersRes as { data: TenantUser[] }).data);
        setSelectedTeamId((prev) => prev || (teamRows[0]?.id ?? ""));
      })
      .catch(() => showAlert(t("roster.failedToLoad")));
  }, []);

  const weekEnd = useMemo(
    () => new Date(weekStart.getTime() + 7 * DAY_MS),
    [weekStart],
  );
  const days = useMemo(
    () =>
      Array.from(
        { length: 7 },
        (_, i) => new Date(weekStart.getTime() + i * DAY_MS),
      ),
    [weekStart],
  );

  // Guards against out-of-order responses: rapid week-paging can let a
  // stale request resolve after a newer one, overwriting the current
  // week's schedules with a previous week's data (review finding).
  const requestIdRef = useRef(0);

  const refresh = useCallback((): void => {
    const requestId = ++requestIdRef.current;
    if (!selectedTeamId) {
      setSchedules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({
      teamId: selectedTeamId,
      from: weekStart.toISOString(),
      to: weekEnd.toISOString(),
      limit: "100",
    });
    fetchWithAuth(`${API_URL}/admin/on-call-schedules?${params.toString()}`)
      .then((res) => {
        if (requestId !== requestIdRef.current) return; // a newer request already resolved
        const rows = (res as { data: OnCallSchedule[] }).data;
        setSchedules(rows);
        setPossiblyTruncated(rows.length >= 100);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        showAlert(t("roster.failedToLoadSchedules"));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [selectedTeamId, weekStart, weekEnd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const userName = (userId: string | null): string =>
    userId
      ? (users.find((u) => u.userId === userId)?.displayName ?? userId)
      : "—";

  async function handleDelete(schedule: OnCallSchedule): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/admin/on-call-schedules/${schedule.id}`, {
        method: "DELETE",
      });
      deleteModal.close();
      refresh();
    } catch {
      showAlert(t("roster.failedToDelete"));
    }
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">{t("roster.title")}</h2>
          <p className="page-subtitle">{t("roster.subtitle")}</p>
        </div>
        <div className="wfl-header-actions">
          <Button
            variant="primary"
            onClick={() => createModal.open()}
            disabled={!selectedTeamId}
          >
            {t("roster.newSchedule")}
          </Button>
        </div>
      </div>

      {possiblyTruncated && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {t("roster.truncatedWarning")}
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <select
          className="form-input"
          style={{ maxWidth: 240 }}
          value={selectedTeamId}
          onChange={(e) => setSelectedTeamId(e.target.value)}
        >
          {teams.length === 0 && (
            <option value="">{t("roster.noTeams")}</option>
          )}
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button
            variant="secondary"
            onClick={() =>
              setWeekStart((d) => new Date(d.getTime() - 7 * DAY_MS))
            }
          >
            ← Prev week
          </Button>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {weekStart.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}
            {" – "}
            {new Date(weekEnd.getTime() - DAY_MS).toLocaleDateString(
              undefined,
              {
                month: "short",
                day: "numeric",
              },
            )}
          </span>
          <Button
            variant="secondary"
            onClick={() =>
              setWeekStart((d) => new Date(d.getTime() + 7 * DAY_MS))
            }
          >
            Next week →
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="loading-center">
          <div className="spinner" />
          <span className="loader-text">{t("roster.loading")}</span>
        </div>
      ) : !selectedTeamId ? (
        <div className="wfl-empty">
          <h4>{t("roster.noTeamSelected")}</h4>
          <p>{t("roster.noTeamDesc")}</p>
        </div>
      ) : (
        <div className="data-panel" style={{ padding: 16 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, 1fr)",
              gap: 4,
              marginBottom: 12,
            }}
          >
            {days.map((d) => (
              <div
                key={d.toISOString()}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  textAlign: "center",
                  color: "var(--text-muted)",
                }}
              >
                {d.toLocaleDateString(undefined, {
                  weekday: "short",
                  day: "numeric",
                })}
              </div>
            ))}
          </div>

          {schedules.length === 0 ? (
            <p
              className="page-subtitle"
              style={{ textAlign: "center", padding: "24px 0" }}
            >
              {t("roster.noSchedulesThisWeek")}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {schedules
                .filter(
                  (s) =>
                    new Date(s.endsAt).getTime() > weekStart.getTime() &&
                    new Date(s.startsAt).getTime() < weekEnd.getTime(),
                )
                .map((s) => {
                  const start = new Date(s.startsAt);
                  const end = new Date(s.endsAt);
                  // Clamp both ends to the visible 7-column grid (0-6 start,
                  // 1-7 end) -- the pre-filter above guarantees a real overlap
                  // exists, so this only trims the portion outside the week,
                  // it never fabricates a bar for a non-overlapping schedule
                  // (review finding: startOffset previously had no upper clamp).
                  const startOffset = Math.min(
                    6,
                    Math.max(
                      0,
                      Math.floor(
                        (start.getTime() - weekStart.getTime()) / DAY_MS,
                      ),
                    ),
                  );
                  const endOffset = Math.min(
                    7,
                    Math.max(
                      startOffset + 1,
                      Math.ceil((end.getTime() - weekStart.getTime()) / DAY_MS),
                    ),
                  );
                  const span = endOffset - startOffset;
                  const color = avatarColor(s.primaryUserId);

                  return (
                    <div
                      key={s.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(7, 1fr)",
                        gap: 4,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => editModal.open(s)}
                        title={`${s.label} — primary ${userName(s.primaryUserId)}`}
                        style={{
                          gridColumnStart: startOffset + 1,
                          gridColumnEnd: `span ${span}`,
                          background: color,
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          padding: "8px 10px",
                          textAlign: "left",
                          cursor: "pointer",
                          fontSize: 12,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <strong>{s.label}</strong> · {userName(s.primaryUserId)}
                      </button>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      <ScheduleFormModal
        open={createModal.isOpen}
        teams={teams}
        defaultTeamId={selectedTeamId}
        users={users}
        onClose={createModal.close}
        onSaved={() => {
          createModal.close();
          refresh();
        }}
      />
      <ScheduleFormModal
        open={editModal.isOpen}
        schedule={editModal.item ?? undefined}
        teams={teams}
        defaultTeamId={selectedTeamId}
        users={users}
        onClose={editModal.close}
        onDelete={() => {
          if (editModal.item) deleteModal.open(editModal.item);
          editModal.close();
        }}
        onSaved={() => {
          editModal.close();
          refresh();
        }}
      />

      <AlertDialog
        open={deleteModal.isOpen}
        onOpenChange={(next) => {
          if (!next) deleteModal.close();
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{t("roster.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteModal.item
              ? t("roster.deleteDesc", { label: deleteModal.item.label })
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("roster.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteModal.item && void handleDelete(deleteModal.item)
              }
            >
              {t("roster.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const tzOffsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

interface ScheduleFormModalProps {
  open: boolean;
  schedule?: OnCallSchedule | undefined;
  teams: Team[];
  defaultTeamId: string;
  users: TenantUser[];
  onClose: () => void;
  onSaved: () => void;
  onDelete?: (() => void) | undefined;
}

interface ScheduleFormData {
  label: string;
  startsAt: string;
  endsAt: string;
  primaryUserId: string;
  backupUserId: string;
  escalationManagerUserId: string;
}

function initialScheduleFormData(schedule?: OnCallSchedule): ScheduleFormData {
  return {
    label: schedule?.label ?? "",
    startsAt: schedule ? toLocalInputValue(schedule.startsAt) : "",
    endsAt: schedule ? toLocalInputValue(schedule.endsAt) : "",
    primaryUserId: schedule?.primaryUserId ?? "",
    backupUserId: schedule?.backupUserId ?? "",
    escalationManagerUserId: schedule?.escalationManagerUserId ?? "",
  };
}

function ScheduleFormModal({
  open,
  schedule,
  teams,
  defaultTeamId,
  users,
  onClose,
  onSaved,
  onDelete,
}: ScheduleFormModalProps): React.ReactElement {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<ScheduleFormData>(() =>
    initialScheduleFormData(schedule),
  );
  // A window's team is fixed once created; a new window picks its team first.
  const [chosenTeamId, setChosenTeamId] = useState(
    schedule?.teamId ?? defaultTeamId,
  );
  // The dropdown always shows a team, so state must agree with it even when
  // the page's team was not selected yet at the moment the modal opened.
  const teamId =
    [schedule?.teamId, chosenTeamId, defaultTeamId, teams[0]?.id].find(
      (id) => !!id,
    ) ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UserPicker portals its dropdown here instead of document.body, so it
  // stays inside DialogContent's DOM subtree -- Radix's Dialog focus trap
  // otherwise forces focus back into that subtree the instant it escapes to
  // an externally-portaled element (broke both search-input autofocus and
  // row-click selection). A callback ref (not a plain useRef) is required
  // here so the state update re-renders once the node first mounts.
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setFormData(initialScheduleFormData(schedule));
      setChosenTeamId(schedule?.teamId ?? defaultTeamId);
      setError(null);
    }
  }, [open, schedule, defaultTeamId]);

  const team = teams.find((t) => t.id === teamId);
  const memberIds = useMemo(
    () => (team?.members ?? []).map((m) => m.userId),
    [team],
  );
  // Pickers offer only the team's members, in rotation order. A team with no
  // members keeps the old any-eligible-user behaviour. When editing, whoever
  // already holds a role stays visible even if they have left the team.
  const pickerUsers = useMemo(() => {
    if (memberIds.length === 0) return users;
    const allowed = new Set(memberIds);
    if (schedule) {
      for (const id of [
        schedule.primaryUserId,
        schedule.backupUserId,
        schedule.escalationManagerUserId,
      ]) {
        if (id) allowed.add(id);
      }
    }
    const byId = new Map(users.map((u) => [u.userId, u]));
    const ordered = memberIds.flatMap((id) => byId.get(id) ?? []);
    const extra = users.filter(
      (u) => allowed.has(u.userId) && !memberIds.includes(u.userId),
    );
    return [...ordered, ...extra];
  }, [memberIds, users, schedule]);

  function changeTeam(nextTeamId: string): void {
    setChosenTeamId(nextTeamId);
    setFormData((prev) => ({
      ...prev,
      primaryUserId: "",
      backupUserId: "",
      escalationManagerUserId: "",
    }));
  }

  const {
    label,
    startsAt,
    endsAt,
    primaryUserId,
    backupUserId,
    escalationManagerUserId,
  } = formData;

  function updateField<K extends keyof ScheduleFormData>(
    key: K,
    value: ScheduleFormData[K],
  ): void {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }

  // PR #623 review (Vijit), G3: a schedule where primary/backup/escalation
  // overlap is a silent misconfiguration -- backup gets paged alongside
  // primary, defeating the point of a backup tier.
  const assignedUserIds = [
    primaryUserId,
    backupUserId,
    escalationManagerUserId,
  ].filter((id) => id.length > 0);
  const hasDuplicateAssignees =
    new Set(assignedUserIds).size !== assignedUserIds.length;

  const isValid =
    label.trim().length > 0 &&
    startsAt.length > 0 &&
    endsAt.length > 0 &&
    teamId.length > 0 &&
    primaryUserId.length > 0 &&
    new Date(startsAt) < new Date(endsAt) &&
    !hasDuplicateAssignees;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!isValid) return;
    setSaving(true);
    setError(null);
    try {
      const path = schedule
        ? `${API_URL}/admin/on-call-schedules/${schedule.id}`
        : `${API_URL}/admin/on-call-schedules`;
      await fetchWithAuth(path, {
        method: schedule ? "PATCH" : "POST",
        body: JSON.stringify({
          ...(schedule ? {} : { teamId }),
          label: label.trim(),
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          primaryUserId,
          backupUserId: backupUserId || undefined,
          escalationManagerUserId: escalationManagerUserId || undefined,
        }),
      });
      onSaved();
    } catch (err) {
      // 5xx already surfaced via the global error banner (lib/api.ts) --
      // avoid showing the same failure twice (PR #602 review, M2).
      const status = (err as { status?: number }).status;
      if (!status || status < 500) {
        setError(err instanceof Error ? err.message : t("roster.failedToSave"));
      }
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
      <DialogContent
        ref={setContentNode}
        showCloseButton={false}
        style={{ maxWidth: 480 }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
          }}
        >
          <DialogTitle asChild>
            <h2 className="page-title">
              {schedule ? t("roster.editSchedule") : t("roster.newSchedule")}
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
            <label className="form-label" htmlFor="schedule-team">
              {t("roster.team")} *
            </label>
            {schedule ? (
              <div id="schedule-team">
                {team?.name ?? t("roster.unknownTeam")}
              </div>
            ) : (
              <select
                id="schedule-team"
                className="form-input"
                value={teamId}
                onChange={(e) => changeTeam(e.target.value)}
              >
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
            )}
            {memberIds.length === 0 && teamId && (
              <p className="page-subtitle">{t("roster.noMembersHint")}</p>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">{t("roster.label")} *</label>
            <input
              className="form-input"
              placeholder={t("roster.labelPlaceholder")}
              value={label}
              autoFocus
              onChange={(e) => updateField("label", e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t("roster.starts")} *</label>
              <input
                className="form-input"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => updateField("startsAt", e.target.value)}
                required
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">{t("roster.ends")} *</label>
              <input
                className="form-input"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => updateField("endsAt", e.target.value)}
                required
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">{t("roster.primaryOncall")} *</label>
            <UserPicker
              users={pickerUsers}
              value={primaryUserId || null}
              onChange={(id) => updateField("primaryUserId", id ?? "")}
              placeholder={t("roster.selectUser")}
              portalContainer={contentNode}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("roster.backupOncall")}</label>
            <UserPicker
              users={pickerUsers}
              value={backupUserId || null}
              onChange={(id) => updateField("backupUserId", id ?? "")}
              placeholder={t("roster.none")}
              portalContainer={contentNode}
            />
          </div>
          <div className="form-group">
            <label className="form-label">
              {t("roster.escalationManager")}
            </label>
            <UserPicker
              users={pickerUsers}
              value={escalationManagerUserId || null}
              onChange={(id) =>
                updateField("escalationManagerUserId", id ?? "")
              }
              placeholder={t("roster.none")}
              portalContainer={contentNode}
            />
          </div>
          {hasDuplicateAssignees && (
            <div className="alert alert-error" style={{ marginTop: 8 }}>
              {t("roster.duplicateAssigneesError")}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              type="submit"
              variant="primary"
              disabled={saving || !isValid}
            >
              {saving
                ? t("roster.saving")
                : schedule
                  ? t("roster.saveChanges")
                  : t("roster.createSchedule")}
            </Button>
            {schedule && onDelete && (
              <Button type="button" variant="secondary" onClick={onDelete}>
                {t("roster.delete")}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
