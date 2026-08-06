import React, { useState } from "react";
import { useList } from "@refinedev/core";
import { Link, useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  Button,
  DIALOG_CONTENT_RESET,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { isRenderableIcon } from "../../lib/icon.js";

type EntityType = {
  id: string;
  name: string;
  plural: string;
  icon: string | null;
  moduleId: string | null;
  allowCustomFields: boolean;
  createdAt: string;
};

type CreateEntityTypeForm = {
  name: string;
  plural: string;
  icon: string;
  allowCustomFields: boolean;
};

const EMPTY_FORM: CreateEntityTypeForm = {
  name: "",
  plural: "",
  icon: "",
  allowCustomFields: true,
};

export function EntityTypes(): React.ReactElement {
  const { data, isLoading, refetch } = useList<EntityType>({
    resource: "entity-types",
  });
  const navigate = useNavigate();
  const types = data?.data ?? [];

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<CreateEntityTypeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byModule = types.reduce<Record<string, EntityType[]>>((acc, t) => {
    const key = t.moduleId ?? "__custom__";
    (acc[key] ??= []).push(t);
    return acc;
  }, {});

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form.name.trim() || !form.plural.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await fetchWithAuth(`${API_URL}/entity-types`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          plural: form.plural.trim(),
          icon: form.icon.trim() || undefined,
          allowCustomFields: form.allowCustomFields,
        }),
      });
      setShowModal(false);
      setForm(EMPTY_FORM);
      void refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading entity types…</span>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "28px",
        }}
      >
        <div>
          <h2 className="page-title">Entity Types</h2>
          <p className="page-subtitle">
            All configurable object schemas in the platform. Entity types define
            the structure, fields, and workflows for every record.
          </p>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div className="stat-pill">{types.length} types</div>
          <Button variant="primary" onClick={() => setShowModal(true)}>
            + New Entity Type
          </Button>
        </div>
      </div>

      {types.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">◻</div>
          <h4>No entity types defined</h4>
          <p>Install a module or create a custom entity type to get started.</p>
        </div>
      ) : (
        <div className="data-panel">
          <Table scroll={false}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Plural</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Custom Fields</TableHead>
                <TableHead>Created</TableHead>
                <TableHead style={{ width: "80px" }}>Records</TableHead>
                <TableHead style={{ width: "40px" }}></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((type) => (
                <TableRow
                  key={type.id}
                  clickable
                  onClick={() => navigate(`/entity-types/${type.id}`)}
                >
                  <TableCell>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                      }}
                    >
                      {isRenderableIcon(type.icon) ? (
                        <span style={{ fontSize: "18px", lineHeight: 1 }}>
                          {type.icon}
                        </span>
                      ) : (
                        <div className="type-icon-placeholder">
                          {type.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <span style={{ fontWeight: 600 }}>{type.name}</span>
                    </div>
                  </TableCell>
                  <TableCell style={{ color: "var(--text-secondary)" }}>
                    {type.plural}
                  </TableCell>
                  <TableCell>
                    {type.moduleId ? (
                      <span className="badge badge-primary">
                        {type.moduleId}
                      </span>
                    ) : (
                      <span
                        style={{ color: "var(--text-muted)", fontSize: "13px" }}
                      >
                        custom
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`badge ${type.allowCustomFields ? "badge-success" : "badge-muted"}`}
                    >
                      {type.allowCustomFields ? "Yes" : "No"}
                    </span>
                  </TableCell>
                  <TableCell
                    style={{ color: "var(--text-muted)", fontSize: "13px" }}
                  >
                    {new Date(type.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      asChild
                      variant="secondary"
                      style={{
                        fontSize: "12px",
                        padding: "4px 10px",
                        textDecoration: "none",
                      }}
                    >
                      <Link
                        to={`/entity-types/${type.id}/records`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        Records
                      </Link>
                    </Button>
                  </TableCell>
                  <TableCell>
                    <button
                      className="btn-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/entity-types/${type.id}`);
                      }}
                    >
                      →
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {Object.keys(byModule).length > 1 && (
        <div
          style={{
            marginTop: "24px",
            display: "flex",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          {Object.entries(byModule).map(([mod, items]) => (
            <div key={mod} className="module-summary-chip">
              <span className="badge badge-primary">
                {mod === "__custom__" ? "custom" : mod}
              </span>
              <span
                style={{
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  marginLeft: "6px",
                }}
              >
                {items.length} types
              </span>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={showModal}
        onOpenChange={(next) => {
          if (!next) setShowModal(false);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="modal"
          style={DIALOG_CONTENT_RESET}
        >
          <div className="modal-header">
            <DialogTitle asChild>
              <h3 className="modal-title">New Entity Type</h3>
            </DialogTitle>
            <DialogClose asChild>
              <button type="button" className="modal-close" aria-label="Close">
                ×
              </button>
            </DialogClose>
          </div>
          <form onSubmit={(e) => void handleCreate(e)}>
            <div className="modal-body">
              {error && (
                <div
                  className="alert alert-error"
                  style={{ marginBottom: "16px" }}
                >
                  {error}
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Name *</label>
                <input
                  className="form-input"
                  placeholder="e.g. Support Ticket"
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label className="form-label">Plural *</label>
                <input
                  className="form-input"
                  placeholder="e.g. Support Tickets"
                  value={form.plural}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, plural: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Icon (emoji)</label>
                <input
                  className="form-input"
                  placeholder="e.g. 🎫"
                  value={form.icon}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, icon: e.target.value }))
                  }
                  style={{ maxWidth: "120px" }}
                />
              </div>
              <div className="form-group">
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={form.allowCustomFields}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        allowCustomFields: e.target.checked,
                      }))
                    }
                  />
                  <span>Allow custom fields</span>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowModal(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "Creating…" : "Create Entity Type"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
