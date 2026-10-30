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
import { useModal } from "../../hooks/use-modal.js";

export interface TeamMember {
  userId: string;
  position: number;
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  members?: TeamMember[];
}

interface OrgUser {
  userId: string;
  displayName: string;
  email: string;
}

// Also set in apps/api/src/routes/admin/teams.ts; the UI does not import server packages.
const MAX_TEAM_MEMBERS = 100;

/**
 * Admin Teams management — docs/specs/oncall-routing.md T17. Plain CRUD
 * list/create/edit/delete against /admin/teams, matching the established
 * admin-ui page conventions (api-keys, users): fetchWithAuth + useState, no
 * Refine data hooks.
 */
export function TeamsPage(): React.ReactElement {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const teamModal = useModal<Team>();
  const deleteModal = useModal<Team>();

  const refresh = useCallback((): void => {
    setLoading(true);
    fetchWithAuth(`${API_URL}/admin/teams`)
      .then((res) => setTeams((res as { data: Team[] }).data))
      .catch(() => showAlert(t("teams.failedToLoad")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The people a team can be built from: the same source as the roster pickers.
  useEffect(() => {
    fetchWithAuth(`${API_URL}/admin/members`)
      .then((res) => setUsers((res as { data?: OrgUser[] } | null)?.data ?? []))
      .catch(() => showAlert(t("teams.failedToLoadUsers")));
  }, []);

  const nameOf = useCallback(
    (userId: string): string =>
      users.find((u) => u.userId === userId)?.displayName ?? userId,
    [users],
  );

  async function handleDelete(team: Team): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/admin/teams/${team.id}`, {
        method: "DELETE",
      });
      deleteModal.close();
      refresh();
    } catch {
      showAlert(t("teams.failedToDelete"));
    }
  }

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">{t("teams.loading")}</span>
      </div>
    );
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">{t("teams.title")}</h2>
          <p className="page-subtitle">{t("teams.subtitle")}</p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={teamModal.openCreate}>
            {t("teams.newTeam")}
          </Button>
        </div>
      </div>

      {teams.length === 0 ? (
        <div className="wfl-empty">
          <h4>{t("teams.noTeams")}</h4>
          <p>{t("teams.noTeamsDesc")}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("teams.name")}</TableHead>
              <TableHead>{t("teams.description")}</TableHead>
              <TableHead>{t("teams.members")}</TableHead>
              <TableHead style={{ width: 120 }}>{t("teams.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {teams.map((team) => (
              <TableRow key={team.id}>
                <TableCell>{team.name}</TableCell>
                <TableCell>{team.description ?? "—"}</TableCell>
                <TableCell>
                  {team.members && team.members.length > 0
                    ? team.members
                        .map((m, i) => `${i + 1}. ${nameOf(m.userId)}`)
                        .join(", ")
                    : "—"}
                </TableCell>
                <TableCell>
                  <div style={{ display: "flex", gap: 6 }}>
                    <IconButton
                      aria-label={t("teams.editTeam")}
                      onClick={() => teamModal.openEdit(team)}
                    >
                      ✎
                    </IconButton>
                    <IconButton
                      aria-label={t("teams.deleteTeam")}
                      onClick={() => deleteModal.open(team)}
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

      <TeamFormModal
        open={teamModal.isOpen}
        team={teamModal.item ?? undefined}
        users={users}
        onClose={teamModal.close}
        onRefresh={refresh}
        onSaved={() => {
          teamModal.close();
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
          <AlertDialogTitle>{t("teams.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteModal.item
              ? t("teams.deleteDesc", { name: deleteModal.item.name })
              : ""}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("teams.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteModal.item) void handleDelete(deleteModal.item);
              }}
            >
              {t("teams.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface TeamFormModalProps {
  open: boolean;
  team?: Team | undefined;
  users: OrgUser[];
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}

function memberIdsOf(team: Team | undefined): string[] {
  return (team?.members ?? []).map((m) => m.userId);
}

function TeamFormModal({
  open,
  team,
  users,
  onClose,
  onSaved,
  onRefresh,
}: TeamFormModalProps): React.ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(memberIdsOf(team));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(team?.name ?? "");
      setDescription(team?.description ?? "");
      setMemberIds(memberIdsOf(team));
      setError(null);
    }
  }, [open, team]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const path = team
        ? `${API_URL}/admin/teams/${team.id}`
        : `${API_URL}/admin/teams`;
      // The two edits are separate requests; the member change goes first
      // because it is the one that can be refused (people checks), so a refusal
      // leaves the name and description untouched.
      let membersSaved = false;
      if (team && memberIds.join("|") !== memberIdsOf(team).join("|")) {
        await fetchWithAuth(`${API_URL}/admin/teams/${team.id}/members`, {
          method: "PUT",
          body: JSON.stringify({ memberUserIds: memberIds }),
        });
        membersSaved = true;
      }
      try {
        await fetchWithAuth(path, {
          method: team ? "PATCH" : "POST",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || undefined,
            ...(team ? {} : { memberUserIds: memberIds }),
          }),
        });
      } catch (err) {
        if (membersSaved) {
          onRefresh();
          setError(
            `Members were saved, but the name and description were not: ${
              err instanceof Error ? err.message : "failed to save team"
            }`,
          );
          return;
        }
        throw err;
      }
      onSaved();
    } catch (err) {
      // 5xx already surfaced via the global error banner (lib/api.ts) --
      // avoid showing the same failure twice (PR #602 review, M2).
      const status = (err as { status?: number }).status;
      if (!status || status < 500) {
        setError(err instanceof Error ? err.message : t("teams.failedToSave"));
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
              {team ? t("teams.editTeam") : t("teams.newTeam")}
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
            <label className="form-label">{t("teams.name")} *</label>
            <input
              className="form-input"
              placeholder={t("teams.namePlaceholder")}
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="form-group">
            <label className="form-label">{t("teams.description")}</label>
            <input
              className="form-input"
              placeholder={t("teams.descriptionPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>
          <MemberListEditor
            users={users}
            memberIds={memberIds}
            onChange={setMemberIds}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim()}
            style={{ marginTop: 8 }}
          >
            {saving
              ? t("teams.saving")
              : team
                ? t("teams.saveChanges")
                : t("teams.createTeam")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface MemberListEditorProps {
  users: OrgUser[];
  memberIds: string[];
  onChange: (next: string[]) => void;
}

// The order here is the rotation order: the recurring roster moves to the next
// person in this list each cycle.
function MemberListEditor({
  users,
  memberIds,
  onChange,
}: MemberListEditorProps): React.ReactElement {
  const { t } = useTranslation();
  const available = users.filter((u) => !memberIds.includes(u.userId));
  const nameOf = (userId: string): string =>
    users.find((u) => u.userId === userId)?.displayName ?? userId;

  function move(index: number, by: -1 | 1): void {
    const next = [...memberIds];
    const target = index + by;
    const moved = next[index];
    const other = next[target];
    if (moved === undefined || other === undefined) return;
    next[index] = other;
    next[target] = moved;
    onChange(next);
  }

  return (
    <div className="form-group">
      <label className="form-label">{t("teams.membersLabel")}</label>
      {memberIds.length === 0 ? (
        <p className="page-subtitle">{t("teams.noMembers")}</p>
      ) : (
        <ol style={{ margin: "0 0 8px", paddingLeft: 20 }}>
          {memberIds.map((userId, i) => (
            <li key={userId} style={{ marginBottom: 4 }}>
              <span style={{ display: "inline-flex", gap: 6 }}>
                <span>{nameOf(userId)}</span>
                <IconButton
                  type="button"
                  aria-label={t("teams.moveUp", { name: nameOf(userId) })}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </IconButton>
                <IconButton
                  type="button"
                  aria-label={t("teams.moveDown", { name: nameOf(userId) })}
                  disabled={i === memberIds.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </IconButton>
                <IconButton
                  type="button"
                  aria-label={t("teams.removeMember", { name: nameOf(userId) })}
                  onClick={() =>
                    onChange(memberIds.filter((id) => id !== userId))
                  }
                >
                  ×
                </IconButton>
              </span>
            </li>
          ))}
        </ol>
      )}
      <select
        className="form-input"
        aria-label={t("teams.addMember")}
        value=""
        disabled={
          memberIds.length >= MAX_TEAM_MEMBERS || available.length === 0
        }
        onChange={(e) => {
          if (e.target.value) onChange([...memberIds, e.target.value]);
        }}
      >
        <option value="">{t("teams.addMemberPlaceholder")}</option>
        {available.map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}
