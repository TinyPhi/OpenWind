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
import {
  CircleActionButton,
  PauseIcon,
  PlayIcon,
  TickIcon,
  TrashIcon,
} from "../../components/action-icons.js";
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
  rotationId?: string | null;
}

interface ProjectedWindow {
  startsAt: string;
  endsAt: string;
  primaryUserId: string;
  backupUserId: string | null;
  escalationManagerUserId: string | null;
}

interface RotationView {
  id: string;
  teamId: string;
  cycleDays: number;
  status: "active" | "stopped";
  blocked: boolean;
  blockedReason: string | null;
  endsOn: string | null;
  nextStartsAt: string;
  nextPrimaryUserId: string | null;
  nextBackupUserId: string | null;
  projected?: ProjectedWindow[];
}

const MIN_CYCLE_DAYS = 3;
const MAX_CYCLE_DAYS = 90;
const DEFAULT_CYCLE_DAYS = 7;

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
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeek(new Date()),
  );
  const [schedules, setSchedules] = useState<OnCallSchedule[]>([]);
  const [rotations, setRotations] = useState<RotationView[]>([]);
  const [loading, setLoading] = useState(true);
  // The list route has no total count in its response, so an exact-limit
  // result is the only signal available that more rows may exist beyond the
  // page (PR #602 review, M3) -- not a precise "there are N more", just a
  // heuristic warning rather than silently showing an incomplete week.
  const [possiblyTruncated, setPossiblyTruncated] = useState(false);
  const createModal = useModal();
  const editModal = useModal<OnCallSchedule>();
  const deleteModal = useModal<OnCallSchedule>();
  const [projectedView, setProjectedView] = useState<ProjectedWindow | null>(
    null,
  );

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
      .catch(() => showAlert("Failed to load teams/users."));
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
        showAlert("Failed to load on-call schedules.");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [selectedTeamId, weekStart, weekEnd]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Rotation state for the selected team (docs/specs/oncall-team-rotation.md R9). A failure only
  // hides the panel; the roster itself still works.
  const refreshRotations = useCallback((): void => {
    if (!selectedTeamId) {
      setRotations([]);
      return;
    }
    void Promise.resolve(
      fetchWithAuth(
        `${API_URL}/admin/on-call-rotations?teamId=${selectedTeamId}`,
      ),
    )
      .then((res) => {
        const data = (res as { data?: unknown } | null)?.data;
        setRotations(Array.isArray(data) ? (data as RotationView[]) : []);
      })
      .catch(() => setRotations([]));
  }, [selectedTeamId]);

  useEffect(() => {
    refreshRotations();
  }, [refreshRotations]);

  // Windows a repeating roster will make later: shown lightly, read-only, for the visible week.
  const projectedThisWeek = rotations
    .flatMap((r) => r.projected ?? [])
    .filter(
      (p) =>
        new Date(p.endsAt).getTime() > weekStart.getTime() &&
        new Date(p.startsAt).getTime() < weekEnd.getTime(),
    );

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
      showAlert("Failed to delete on-call schedule.");
    }
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">On-Call Roster</h2>
          <p className="page-subtitle">
            Weekly coverage per team — primary, backup, and escalation on-call.
          </p>
        </div>
        <div className="wfl-header-actions">
          <Button
            variant="primary"
            onClick={() => createModal.open()}
            disabled={!selectedTeamId}
          >
            New Schedule
          </Button>
        </div>
      </div>

      {possiblyTruncated && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          ⚠ This team has 100+ overlapping schedules in this week's view — some
          may not be shown.
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
          {teams.length === 0 && <option value="">No teams</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
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
          <span className="loader-text">Loading roster…</span>
        </div>
      ) : !selectedTeamId ? (
        <div className="wfl-empty">
          <h4>No team selected</h4>
          <p>Create a team first to build its on-call roster.</p>
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

          {schedules.length === 0 && projectedThisWeek.length === 0 ? (
            <p
              className="page-subtitle"
              style={{ textAlign: "center", padding: "24px 0" }}
            >
              No on-call schedules this week for this team.
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
                        title={`${s.label} — primary ${userName(s.primaryUserId)}${s.rotationId ? " (repeating roster)" : ""}`}
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
                        {s.rotationId && (
                          <span
                            aria-label="Repeating roster"
                            title="Part of a repeating roster"
                          >
                            ↻{" "}
                          </span>
                        )}
                        <strong>{s.label}</strong> · {userName(s.primaryUserId)}
                      </button>
                    </div>
                  );
                })}
              {projectedThisWeek.map((p) => {
                const start = new Date(p.startsAt);
                const end = new Date(p.endsAt);
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
                const color = avatarColor(p.primaryUserId);
                return (
                  <div
                    key={`projected-${p.startsAt}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(7, 1fr)",
                      gap: 4,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setProjectedView(p)}
                      title={`Upcoming, not active yet — primary ${userName(p.primaryUserId)}`}
                      style={{
                        gridColumnStart: startOffset + 1,
                        gridColumnEnd: `span ${endOffset - startOffset}`,
                        background: `color-mix(in srgb, ${color} 25%, transparent)`,
                        color: "var(--text-primary)",
                        border: `1.5px dashed ${color}`,
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
                      <span aria-hidden="true">↻ </span>
                      <strong>Upcoming</strong> · {userName(p.primaryUserId)}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Dialog
        open={projectedView !== null}
        onOpenChange={(next) => {
          if (!next) setProjectedView(null);
        }}
      >
        <DialogContent showCloseButton={false} style={{ maxWidth: 520 }}>
          <DialogTitle>Upcoming window</DialogTitle>
          {projectedView && (
            <>
              <p className="page-subtitle">
                Not active yet. The repeating roster makes this window
                automatically, about two days before it starts. This is a
                preview, so it cannot be edited here.
              </p>
              <dl
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "6px 16px",
                }}
              >
                <dt>From</dt>
                <dd>{new Date(projectedView.startsAt).toLocaleString()}</dd>
                <dt>To</dt>
                <dd>{new Date(projectedView.endsAt).toLocaleString()}</dd>
                <dt>Primary</dt>
                <dd>{userName(projectedView.primaryUserId)}</dd>
                <dt>Backup</dt>
                <dd>
                  {projectedView.backupUserId
                    ? userName(projectedView.backupUserId)
                    : "None"}
                </dd>
                <dt>Escalation manager</dt>
                <dd>
                  {projectedView.escalationManagerUserId
                    ? userName(projectedView.escalationManagerUserId)
                    : "None"}
                </dd>
              </dl>
              <p className="page-subtitle">
                To change who is on call, edit the team's members or the current
                window; the preview follows.
              </p>
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ScheduleFormModal
        open={createModal.isOpen}
        teams={teams}
        defaultTeamId={selectedTeamId}
        users={users}
        onClose={createModal.close}
        onSaved={() => {
          createModal.close();
          refresh();
          refreshRotations();
        }}
      />
      <ScheduleFormModal
        open={editModal.isOpen}
        schedule={editModal.item ?? undefined}
        rotation={rotations.find((r) => r.id === editModal.item?.rotationId)}
        userName={userName}
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
          refreshRotations();
        }}
      />

      <AlertDialog
        open={deleteModal.isOpen}
        onOpenChange={(next) => {
          if (!next) deleteModal.close();
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete on-call schedule?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteModal.item
              ? deleteModal.item.rotationId
                ? `"${deleteModal.item.label}" is part of a repeating roster. Deleting it removes this window from the roster and nobody is on call for that time unless you cover it. The roster will not make it again and keeps repeating after it. To stop the repeat, pause the roster instead. This cannot be undone.`
                : `"${deleteModal.item.label}" will be removed from the roster. This cannot be undone.`
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleteModal.item && void handleDelete(deleteModal.item)
              }
            >
              Delete
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
  /** The repeating roster this window belongs to, when editing one. */
  rotation?: RotationView | undefined;
  userName?: ((userId: string | null) => string) | undefined;
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
  repeatOn: boolean;
  overrideEnd: boolean;
  cycleDays: string;
}

// A window made before cycles existed may not be a whole number of days; those keep a typed end.
function wholeCycleDays(schedule: OnCallSchedule): number | null {
  const days =
    (new Date(schedule.endsAt).getTime() -
      new Date(schedule.startsAt).getTime()) /
    DAY_MS;
  return Number.isInteger(days) &&
    days >= MIN_CYCLE_DAYS &&
    days <= MAX_CYCLE_DAYS
    ? days
    : null;
}

function initialScheduleFormData(
  schedule?: OnCallSchedule,
  rotation?: RotationView,
): ScheduleFormData {
  return {
    label: schedule?.label ?? "",
    startsAt: schedule ? toLocalInputValue(schedule.startsAt) : "",
    endsAt: schedule ? toLocalInputValue(schedule.endsAt) : "",
    primaryUserId: schedule?.primaryUserId ?? "",
    backupUserId: schedule?.backupUserId ?? "",
    escalationManagerUserId: schedule?.escalationManagerUserId ?? "",
    repeatOn: rotation?.status === "active",
    overrideEnd: false,
    cycleDays: String(
      (schedule ? wholeCycleDays(schedule) : null) ?? DEFAULT_CYCLE_DAYS,
    ),
  };
}

function ScheduleFormModal({
  open,
  schedule,
  rotation,
  userName,
  teams,
  defaultTeamId,
  users,
  onClose,
  onSaved,
  onDelete,
}: ScheduleFormModalProps): React.ReactElement {
  const [formData, setFormData] = useState<ScheduleFormData>(() =>
    initialScheduleFormData(schedule, rotation),
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
  const [confirmingPause, setConfirmingPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UserPicker portals its dropdown here instead of document.body, so it
  // stays inside DialogContent's DOM subtree -- Radix's Dialog focus trap
  // otherwise forces focus back into that subtree the instant it escapes to
  // an externally-portaled element (broke both search-input autofocus and
  // row-click selection). A callback ref (not a plain useRef) is required
  // here so the state update re-renders once the node first mounts.
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);

  const rotationStatus = rotation?.status;

  useEffect(() => {
    if (open) {
      setFormData(initialScheduleFormData(schedule, rotation));
      setChosenTeamId(schedule?.teamId ?? defaultTeamId);
      setError(null);
    }
  }, [open, schedule, rotationStatus, defaultTeamId]);

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
    repeatOn,
    overrideEnd,
    cycleDays,
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

  const cycleDaysNumber = Number(cycleDays);
  const cycleDaysValid =
    Number.isInteger(cycleDaysNumber) &&
    cycleDaysNumber >= MIN_CYCLE_DAYS &&
    cycleDaysNumber <= MAX_CYCLE_DAYS;
  // A repeating roster rotates through the team, so it needs members to rotate through.
  const canRepeat = schedule ? !!rotation : memberIds.length > 0;
  const repeating = repeatOn && canRepeat;
  // A window that is running can only have its end changed.
  const started = !!schedule && new Date(schedule.startsAt) <= new Date();
  const autoEnd = !schedule || wholeCycleDays(schedule) !== null;
  // Un-ticking repeat on a running roster asks what to do with this cycle's end.
  const stoppingRepeat =
    !!schedule && rotation?.status === "active" && !repeatOn;
  const endEditable = !autoEnd || (stoppingRepeat && overrideEnd);
  // A window is exactly one cycle long, so its end is worked out, not typed.
  const effectiveEndsAt =
    autoEnd &&
    !endEditable &&
    cycleDaysValid &&
    startsAt &&
    !Number.isNaN(new Date(startsAt).getTime())
      ? toLocalInputValue(
          new Date(
            new Date(startsAt).getTime() + cycleDaysNumber * DAY_MS,
          ).toISOString(),
        )
      : endsAt;

  const isValid =
    label.trim().length > 0 &&
    startsAt.length > 0 &&
    effectiveEndsAt.length > 0 &&
    teamId.length > 0 &&
    primaryUserId.length > 0 &&
    new Date(startsAt) < new Date(effectiveEndsAt) &&
    !hasDuplicateAssignees &&
    (!autoEnd || endEditable || cycleDaysValid);

  // Pause and resume act on the whole repeating roster right away, apart from the form fields.
  async function changeRotation(status: "active" | "stopped"): Promise<void> {
    if (!rotation) return;
    setSaving(true);
    setError(null);
    try {
      await fetchWithAuth(`${API_URL}/admin/on-call-rotations/${rotation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setConfirmingPause(false);
      onSaved();
    } catch (err) {
      setConfirmingPause(false);
      const code = (err as { status?: number }).status;
      if (!code || code < 500) {
        setError(
          err instanceof Error ? err.message : "Failed to update the roster",
        );
      }
    } finally {
      setSaving(false);
    }
  }

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
          // On an edit only what changed is sent: a running window refuses a changed start or
          // people, and the minute-precision input would otherwise look like a changed start.
          ...(!schedule || startsAt !== toLocalInputValue(schedule.startsAt)
            ? { startsAt: new Date(startsAt).toISOString() }
            : {}),
          endsAt: new Date(effectiveEndsAt).toISOString(),
          ...(primaryUserId !== schedule?.primaryUserId
            ? { primaryUserId }
            : {}),
          ...(!schedule || backupUserId !== (schedule.backupUserId ?? "")
            ? { backupUserId: backupUserId || undefined }
            : {}),
          ...(!schedule ||
          escalationManagerUserId !== (schedule.escalationManagerUserId ?? "")
            ? {
                escalationManagerUserId: escalationManagerUserId || undefined,
              }
            : {}),
          ...(!schedule && repeating
            ? { repeat: { cycleDays: cycleDaysNumber } }
            : {}),
        }),
      });
      if (
        schedule &&
        rotation &&
        repeating !== (rotation.status === "active")
      ) {
        await fetchWithAuth(
          `${API_URL}/admin/on-call-rotations/${rotation.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ status: repeating ? "active" : "stopped" }),
          },
        );
      }
      onSaved();
    } catch (err) {
      // 5xx already surfaced via the global error banner (lib/api.ts) --
      // avoid showing the same failure twice (PR #602 review, M2).
      const status = (err as { status?: number }).status;
      if (!status || status < 500) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to save on-call schedule",
        );
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
        style={{ maxWidth: 680 }}
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
              {schedule ? "Edit On-Call Schedule" : "New On-Call Schedule"}
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
              Team *
            </label>
            {schedule ? (
              <div id="schedule-team">{team?.name ?? "Unknown team"}</div>
            ) : (
              <select
                id="schedule-team"
                className="form-input"
                value={teamId}
                onChange={(e) => changeTeam(e.target.value)}
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            {memberIds.length === 0 && teamId && (
              <p className="page-subtitle">
                This team has no members yet, so anyone eligible can be picked.
                Adding members to the team limits the choice to them.
              </p>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Label *</label>
            <input
              className="form-input"
              placeholder="e.g. Week 1"
              value={label}
              autoFocus
              onChange={(e) => updateField("label", e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Starts *</label>
              <input
                className="form-input"
                type="datetime-local"
                value={startsAt}
                disabled={started}
                onChange={(e) => updateField("startsAt", e.target.value)}
                required
              />
            </div>
            {autoEnd && (
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label" htmlFor="schedule-cycle-days">
                  Cycle length (days) *
                </label>
                <input
                  id="schedule-cycle-days"
                  aria-label="Cycle length in days"
                  className="form-input"
                  type="number"
                  min={MIN_CYCLE_DAYS}
                  max={MAX_CYCLE_DAYS}
                  value={cycleDays}
                  disabled={endEditable}
                  onChange={(e) => updateField("cycleDays", e.target.value)}
                />
              </div>
            )}
          </div>
          {started && (
            <p className="page-subtitle">
              This window is already running, so only its end can be changed.
            </p>
          )}
          <div className="form-group">
            <label className="form-label">Ends *</label>
            <input
              className="form-input"
              type="datetime-local"
              value={effectiveEndsAt}
              disabled={!endEditable}
              onChange={(e) => updateField("endsAt", e.target.value)}
              required
            />
            {autoEnd && !endEditable && (
              <p className="page-subtitle">
                Worked out from the start and the cycle length.
              </p>
            )}
            {autoEnd && !cycleDaysValid && (
              <div className="alert alert-error">
                Use a whole number of days from {MIN_CYCLE_DAYS} to{" "}
                {MAX_CYCLE_DAYS}.
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label">Primary on-call *</label>
            <UserPicker
              users={pickerUsers}
              disabled={started}
              value={primaryUserId || null}
              onChange={(id) => updateField("primaryUserId", id ?? "")}
              placeholder="Select a user"
              portalContainer={contentNode}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Backup on-call</label>
            <UserPicker
              users={pickerUsers}
              disabled={started}
              value={backupUserId || null}
              onChange={(id) => updateField("backupUserId", id ?? "")}
              placeholder="None"
              portalContainer={contentNode}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Escalation manager</label>
            <UserPicker
              users={pickerUsers}
              disabled={started}
              value={escalationManagerUserId || null}
              onChange={(id) =>
                updateField("escalationManagerUserId", id ?? "")
              }
              placeholder="None"
              portalContainer={contentNode}
            />
          </div>
          {(!schedule || rotation) && (
            <div className="form-group">
              <label className="form-label" htmlFor="schedule-repeat">
                <input
                  id="schedule-repeat"
                  type="checkbox"
                  checked={repeatOn && canRepeat}
                  disabled={!canRepeat}
                  onChange={(e) => updateField("repeatOn", e.target.checked)}
                />{" "}
                Repeat automatically
              </label>
              {!canRepeat ? (
                <p className="page-subtitle">
                  Repeating needs a team with at least one member.
                </p>
              ) : (
                <p className="page-subtitle">
                  When this window ends, the next one starts on its own and
                  lasts the same number of days. The next member in the team
                  takes over as primary, and the one after as backup, in the
                  team's member order. Untick it to stop repeating; windows
                  already made stay.
                </p>
              )}
              {schedule && rotation && repeating && userName && (
                <p className="page-subtitle">
                  Next window starts{" "}
                  {new Date(rotation.nextStartsAt).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric", year: "numeric" },
                  )}
                  {rotation.nextPrimaryUserId
                    ? `: primary ${userName(rotation.nextPrimaryUserId)}`
                    : ""}
                  {rotation.nextBackupUserId
                    ? `, backup ${userName(rotation.nextBackupUserId)}`
                    : ""}
                  .
                </p>
              )}
              {schedule && rotation?.blocked && rotation.blockedReason && (
                <div className="alert alert-error">
                  {rotation.blockedReason}
                </div>
              )}
              {stoppingRepeat && (
                <fieldset
                  style={{ border: "none", padding: 0, margin: "8px 0" }}
                >
                  <legend className="form-label">
                    Repeat is off. This window's end:
                  </legend>
                  <label style={{ display: "block" }}>
                    <input
                      type="radio"
                      name="schedule-end-choice"
                      checked={!overrideEnd}
                      onChange={() => updateField("overrideEnd", false)}
                    />{" "}
                    Keep it as set ({cycleDaysNumber}-day cycle)
                  </label>
                  <label style={{ display: "block" }}>
                    <input
                      type="radio"
                      name="schedule-end-choice"
                      checked={overrideEnd}
                      onChange={() => updateField("overrideEnd", true)}
                    />{" "}
                    Change it (pick the end above)
                  </label>
                </fieldset>
              )}
              {schedule && rotation && (
                <div style={{ marginTop: 8 }}>
                  {confirmingPause ? (
                    <div className="alert alert-error">
                      <p style={{ margin: "0 0 8px" }}>
                        Pause this roster? No new windows will be made and the
                        upcoming windows that have not started are removed. The
                        window running now stays until it ends. While paused you
                        can create another roster for this team at the same
                        time, but then this one can no longer be resumed: only
                        one roster can run at a time.
                      </p>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={saving}
                          onClick={() => void changeRotation("stopped")}
                        >
                          Pause roster
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => setConfirmingPause(false)}
                        >
                          Keep running
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}
          {hasDuplicateAssignees && (
            <div className="alert alert-error" style={{ marginTop: 8 }}>
              Primary, backup, and escalation manager must be different people —
              the same person can't cover their own backup.
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 16,
              justifyContent: "flex-end",
            }}
          >
            {schedule && rotation && (
              <CircleActionButton
                type="button"
                color="yellow"
                label={
                  rotation.status === "active"
                    ? "Pause roster"
                    : "Resume roster"
                }
                icon={
                  rotation.status === "active" ? <PauseIcon /> : <PlayIcon />
                }
                disabled={saving || confirmingPause}
                onClick={() =>
                  rotation.status === "active"
                    ? setConfirmingPause(true)
                    : void changeRotation("active")
                }
              />
            )}
            {schedule && onDelete && (
              <CircleActionButton
                type="button"
                color="red"
                label="Delete schedule"
                icon={<TrashIcon />}
                onClick={onDelete}
              />
            )}
            <CircleActionButton
              type="submit"
              color="green"
              label={schedule ? "Save changes" : "Create schedule"}
              icon={<TickIcon />}
              disabled={saving || !isValid}
            />
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
