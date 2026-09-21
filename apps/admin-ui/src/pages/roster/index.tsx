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

const AVATAR_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#ef4444",
  "#14b8a6",
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#6366f1";
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
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OnCallSchedule | null>(null);
  const [deleting, setDeleting] = useState<OnCallSchedule | null>(null);

  useEffect(() => {
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/teams`),
      // Admin-only endpoint for on-call assignee pickers (PR #602 review,
      // BLOCKER-1) -- separate from GET /users, the customer-facing @mention
      // picker. Returns all org members (admin + user roles, no "agent"
      // role in this deployment).
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

  const userName = (userId: string | null): string =>
    userId
      ? (users.find((u) => u.userId === userId)?.displayName ?? userId)
      : "—";

  async function handleDelete(schedule: OnCallSchedule): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/admin/on-call-schedules/${schedule.id}`, {
        method: "DELETE",
      });
      setDeleting(null);
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
            onClick={() => setCreating(true)}
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

          {schedules.length === 0 ? (
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
                        onClick={() => setEditing(s)}
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
        open={creating}
        teamId={selectedTeamId}
        users={users}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          refresh();
        }}
      />
      <ScheduleFormModal
        open={editing !== null}
        schedule={editing ?? undefined}
        teamId={selectedTeamId}
        users={users}
        onClose={() => setEditing(null)}
        onDelete={() => {
          if (editing) setDeleting(editing);
          setEditing(null);
        }}
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
          <AlertDialogTitle>Delete on-call schedule?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? `"${deleting.label}" will be removed from the roster.`
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

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const tzOffsetMs = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

interface ScheduleFormModalProps {
  open: boolean;
  schedule?: OnCallSchedule | undefined;
  teamId: string;
  users: TenantUser[];
  onClose: () => void;
  onSaved: () => void;
  onDelete?: (() => void) | undefined;
}

function ScheduleFormModal({
  open,
  schedule,
  teamId,
  users,
  onClose,
  onSaved,
  onDelete,
}: ScheduleFormModalProps): React.ReactElement {
  const [label, setLabel] = useState(schedule?.label ?? "");
  const [startsAt, setStartsAt] = useState(
    schedule ? toLocalInputValue(schedule.startsAt) : "",
  );
  const [endsAt, setEndsAt] = useState(
    schedule ? toLocalInputValue(schedule.endsAt) : "",
  );
  const [primaryUserId, setPrimaryUserId] = useState(
    schedule?.primaryUserId ?? "",
  );
  const [backupUserId, setBackupUserId] = useState(
    schedule?.backupUserId ?? "",
  );
  const [escalationManagerUserId, setEscalationManagerUserId] = useState(
    schedule?.escalationManagerUserId ?? "",
  );
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
      setLabel(schedule?.label ?? "");
      setStartsAt(schedule ? toLocalInputValue(schedule.startsAt) : "");
      setEndsAt(schedule ? toLocalInputValue(schedule.endsAt) : "");
      setPrimaryUserId(schedule?.primaryUserId ?? "");
      setBackupUserId(schedule?.backupUserId ?? "");
      setEscalationManagerUserId(schedule?.escalationManagerUserId ?? "");
      setError(null);
    }
  }, [open, schedule]);

  const isValid =
    label.trim().length > 0 &&
    startsAt.length > 0 &&
    endsAt.length > 0 &&
    primaryUserId.length > 0 &&
    new Date(startsAt) < new Date(endsAt);

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
            <label className="form-label">Label *</label>
            <input
              className="form-input"
              placeholder="e.g. Week 1"
              value={label}
              autoFocus
              onChange={(e) => setLabel(e.target.value)}
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
                onChange={(e) => setStartsAt(e.target.value)}
                required
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Ends *</label>
              <input
                className="form-input"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Primary on-call *</label>
            <UserPicker
              users={users}
              value={primaryUserId || null}
              onChange={(id) => setPrimaryUserId(id ?? "")}
              placeholder="Select a user"
              portalContainer={contentNode}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Backup on-call</label>
            <UserPicker
              users={users}
              value={backupUserId || null}
              onChange={(id) => setBackupUserId(id ?? "")}
              placeholder="None"
              portalContainer={contentNode}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Escalation manager</label>
            <UserPicker
              users={users}
              value={escalationManagerUserId || null}
              onChange={(id) => setEscalationManagerUserId(id ?? "")}
              placeholder="None"
              portalContainer={contentNode}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button
              type="submit"
              variant="primary"
              disabled={saving || !isValid}
            >
              {saving
                ? "Saving…"
                : schedule
                  ? "Save changes"
                  : "Create schedule"}
            </Button>
            {schedule && onDelete && (
              <Button type="button" variant="secondary" onClick={onDelete}>
                Delete
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
