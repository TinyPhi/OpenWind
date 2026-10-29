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

export interface Team {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

/**
 * Admin Teams management — docs/specs/oncall-routing.md T17. Plain CRUD
 * list/create/edit/delete against /admin/teams, matching the established
 * admin-ui page conventions (api-keys, users): fetchWithAuth + useState, no
 * Refine data hooks.
 */
export function TeamsPage(): React.ReactElement {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<Team[]>([]);
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
              <TableHead style={{ width: 120 }}>{t("teams.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {teams.map((team) => (
              <TableRow key={team.id}>
                <TableCell>{team.name}</TableCell>
                <TableCell>{team.description ?? "—"}</TableCell>
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
        onClose={teamModal.close}
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
  onClose: () => void;
  onSaved: () => void;
}

function TeamFormModal({
  open,
  team,
  onClose,
  onSaved,
}: TeamFormModalProps): React.ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(team?.name ?? "");
      setDescription(team?.description ?? "");
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
      await fetchWithAuth(path, {
        method: team ? "PATCH" : "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
        }),
      });
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
      <DialogContent showCloseButton={false} style={{ maxWidth: 440 }}>
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
