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
import type { Team } from "../teams/index.js";

export interface Service {
  id: string;
  name: string;
  description: string | null;
  teamId: string | null;
  createdAt: string;
}

/**
 * Admin Services management — docs/specs/oncall-routing.md T17 (bundled with
 * teams). Same CRUD convention as teams/index.tsx, plus an optional team
 * picker (services.teamId, no DB FK — apps/api's route validates cross-tenant
 * ownership at write time, see services.ts's own header comment).
 */
export function ServicesPage(): React.ReactElement {
  const [services, setServices] = useState<Service[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Service | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Service | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    Promise.all([
      fetchWithAuth(`${API_URL}/admin/services`),
      fetchWithAuth(`${API_URL}/admin/teams`),
    ])
      .then(([servicesRes, teamsRes]) => {
        setServices((servicesRes as { data: Service[] }).data);
        setTeams((teamsRes as { data: Team[] }).data);
      })
      .catch(() => showAlert("Failed to load services."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const teamName = (teamId: string | null): string =>
    teamId ? (teams.find((t) => t.id === teamId)?.name ?? "—") : "—";

  async function handleDelete(service: Service): Promise<void> {
    try {
      await fetchWithAuth(`${API_URL}/admin/services/${service.id}`, {
        method: "DELETE",
      });
      setDeleting(null);
      refresh();
    } catch {
      showAlert("Failed to delete service.");
    }
  }

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading services…</span>
      </div>
    );
  }

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">Services</h2>
          <p className="page-subtitle">
            Optionally grouped under a team for on-call routing purposes.
          </p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={() => setCreating(true)}>
            New Service
          </Button>
        </div>
      </div>

      {services.length === 0 ? (
        <div className="wfl-empty">
          <h4>No services yet</h4>
          <p>Create one to organize tickets by the system they affect.</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Team</TableHead>
              <TableHead style={{ width: 120 }}>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((service) => (
              <TableRow key={service.id}>
                <TableCell>{service.name}</TableCell>
                <TableCell>{service.description ?? "—"}</TableCell>
                <TableCell>{teamName(service.teamId)}</TableCell>
                <TableCell>
                  <div style={{ display: "flex", gap: 6 }}>
                    <IconButton
                      aria-label="Edit service"
                      onClick={() => setEditing(service)}
                    >
                      ✎
                    </IconButton>
                    <IconButton
                      aria-label="Delete service"
                      onClick={() => setDeleting(service)}
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

      <ServiceFormModal
        open={creating}
        teams={teams}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          refresh();
        }}
      />
      <ServiceFormModal
        open={editing !== null}
        service={editing ?? undefined}
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
          <AlertDialogTitle>Delete service?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleting ? `"${deleting.name}" will be archived.` : ""}
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

interface ServiceFormModalProps {
  open: boolean;
  service?: Service | undefined;
  teams: Team[];
  onClose: () => void;
  onSaved: () => void;
}

function ServiceFormModal({
  open,
  service,
  teams,
  onClose,
  onSaved,
}: ServiceFormModalProps): React.ReactElement {
  const [name, setName] = useState(service?.name ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [teamId, setTeamId] = useState(service?.teamId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(service?.name ?? "");
      setDescription(service?.description ?? "");
      setTeamId(service?.teamId ?? "");
      setError(null);
    }
  }, [open, service]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const path = service
        ? `${API_URL}/admin/services/${service.id}`
        : `${API_URL}/admin/services`;
      await fetchWithAuth(path, {
        method: service ? "PATCH" : "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          teamId: teamId || undefined,
        }),
      });
      onSaved();
    } catch (err) {
      // 5xx already surfaced via the global error banner (lib/api.ts) --
      // avoid showing the same failure twice (PR #602 review, M2).
      const status = (err as { status?: number }).status;
      if (!status || status < 500) {
        setError(err instanceof Error ? err.message : "Failed to save service");
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
              {service ? "Edit Service" : "New Service"}
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
              placeholder="e.g. Payments API"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input
              className="form-input"
              placeholder="What this service does"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Team</label>
            <select
              className="form-input"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
            >
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim()}
            style={{ marginTop: 8 }}
          >
            {saving ? "Saving…" : service ? "Save changes" : "Create service"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
