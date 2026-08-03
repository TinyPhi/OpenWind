import React, { useEffect, useState } from "react";
import { useOne } from "@refinedev/core";
import { useParams, Link } from "react-router-dom";
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
import {
  showAlert,
  showConfirm,
} from "../../components/global-alert-dialog.js";

type EntityType = {
  id: string;
  name: string;
  plural: string;
  icon: string | null;
  moduleId: string | null;
  allowCustomFields: boolean;
  createdAt: string;
};

type EnumOption = string | { label: string; value: string; color?: string };

type FieldConfig = {
  options?: EnumOption[];
  entityTypeId?: string;
  [key: string]: unknown;
};

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  config: FieldConfig;
  isRequired: boolean;
  isIndexed: boolean;
  isSystem: boolean;
  sortOrder: number;
  createdAt: string;
};

const FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "currency",
  "date",
  "datetime",
  "boolean",
  "enum",
  "multi_enum",
  "user_ref",
  "entity_ref",
  "file",
  "files",
  "formula",
  "lookup",
] as const;

type FieldTypeVal = (typeof FIELD_TYPES)[number];

type EnumRow = { label: string };

type AddFieldForm = {
  name: string;
  label: string;
  fieldType: FieldTypeVal;
  isRequired: boolean;
  isIndexed: boolean;
  sortOrder: number;
  enumRows: EnumRow[];
};

const EMPTY_FIELD: AddFieldForm = {
  name: "",
  label: "",
  fieldType: "text",
  isRequired: false,
  isIndexed: false,
  sortOrder: 0,
  enumRows: [{ label: "" }],
};

function labelToValue(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

const FIELD_TYPE_STYLE: Record<string, { bg: string; color: string }> = {
  text: { bg: "hsla(210, 80%, 55%, 0.12)", color: "hsl(210, 80%, 72%)" },
  longtext: { bg: "hsla(230, 80%, 55%, 0.12)", color: "hsl(230, 80%, 72%)" },
  textarea: { bg: "hsla(250, 80%, 55%, 0.12)", color: "hsl(250, 80%, 72%)" },
  select: { bg: "hsla(280, 80%, 55%, 0.12)", color: "hsl(280, 80%, 72%)" },
  enum: { bg: "hsla(280, 80%, 55%, 0.12)", color: "hsl(280, 80%, 72%)" },
  multi_enum: { bg: "hsla(300, 80%, 55%, 0.12)", color: "hsl(300, 80%, 72%)" },
  entity_ref: { bg: "hsla(30, 80%, 55%, 0.12)", color: "hsl(30, 80%, 72%)" },
  user_ref: { bg: "hsla(170, 70%, 45%, 0.12)", color: "hsl(170, 70%, 62%)" },
  number: { bg: "hsla(150, 70%, 45%, 0.12)", color: "hsl(150, 70%, 62%)" },
  currency: { bg: "hsla(140, 70%, 45%, 0.12)", color: "hsl(140, 70%, 62%)" },
  boolean: { bg: "hsla(45, 90%, 55%, 0.12)", color: "hsl(45, 90%, 67%)" },
  date: { bg: "hsla(0, 70%, 55%, 0.12)", color: "hsl(0, 70%, 72%)" },
  datetime: { bg: "hsla(10, 70%, 55%, 0.12)", color: "hsl(10, 70%, 72%)" },
};

const FALLBACK_STYLE = {
  bg: "hsla(225, 20%, 40%, 0.12)",
  color: "var(--text-muted)",
};

function EnumOptionsList({
  rows,
  onChange,
}: {
  rows: EnumRow[];
  onChange: (rows: EnumRow[]) => void;
}): React.ReactElement {
  function update(i: number, label: string): void {
    const next = rows.map((r, idx) => (idx === i ? { label } : r));
    onChange(next);
  }
  function remove(i: number): void {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function add(): void {
    onChange([...rows, { label: "" }]);
  }

  return (
    <div className="enum-opts-list">
      {rows.map((row, i) => (
        <div key={i} className="enum-opt-row">
          <input
            className="form-input"
            placeholder={`Option ${i + 1}`}
            value={row.label}
            onChange={(e) => update(i, e.target.value)}
            autoFocus={i === rows.length - 1 && row.label === ""}
          />
          <span className="enum-opt-key" title="Auto-generated key">
            {row.label.trim() ? labelToValue(row.label) : "key"}
          </span>
          <button
            type="button"
            className="enum-opt-remove"
            onClick={() => remove(i)}
            disabled={rows.length === 1}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="enum-opt-add" onClick={add}>
        + Add option
      </button>
    </div>
  );
}

export function EntityTypeDetail(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useOne<EntityType>({
    resource: "entity-types",
    id: id ?? "missing",
  });

  const [fields, setFields] = useState<EntityField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(true);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [showAddField, setShowAddField] = useState(false);
  const [fieldForm, setFieldForm] = useState<AddFieldForm>(EMPTY_FIELD);
  const [savingField, setSavingField] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [deletingFieldId, setDeletingFieldId] = useState<string | null>(null);

  // Edit field state
  const [editingField, setEditingField] = useState<EntityField | null>(null);
  const [editForm, setEditForm] = useState({
    label: "",
    isRequired: false,
    sortOrder: 0,
    enumRows: [{ label: "" }] as EnumRow[],
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function loadFields(): void {
    if (!id) return;
    setFieldsLoading(true);
    setFieldsError(null);
    fetchWithAuth(`${API_URL}/entity-types/${id}/fields`)
      .then((res) => {
        const result = res as { data: EntityField[] };
        setFields(result.data);
      })
      .catch((err: unknown) => {
        setFieldsError(
          err instanceof Error ? err.message : "Failed to load fields",
        );
        setFields([]);
      })
      .finally(() => setFieldsLoading(false));
  }

  useEffect(() => {
    loadFields();
  }, [id]);

  async function handleAddField(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!id) return;
    setSavingField(true);
    setFieldError(null);
    try {
      const config: Record<string, unknown> = {};
      if (
        fieldForm.fieldType === "enum" ||
        fieldForm.fieldType === "multi_enum"
      ) {
        config["options"] = fieldForm.enumRows
          .filter((r) => r.label.trim())
          .map((r) => ({
            label: r.label.trim(),
            value: labelToValue(r.label),
          }));
      }
      await fetchWithAuth(`${API_URL}/entity-types/${id}/fields`, {
        method: "POST",
        body: JSON.stringify({
          name: fieldForm.name.trim(),
          label: fieldForm.label.trim(),
          fieldType: fieldForm.fieldType,
          isRequired: fieldForm.isRequired,
          isIndexed: fieldForm.isIndexed,
          sortOrder: fieldForm.sortOrder,
          config,
        }),
      });
      setShowAddField(false);
      setFieldForm(EMPTY_FIELD);
      loadFields();
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : "Failed to add field");
    } finally {
      setSavingField(false);
    }
  }

  async function handleDeleteField(fieldId: string): Promise<void> {
    if (!id) return;
    setDeletingFieldId(fieldId);
    try {
      await fetchWithAuth(`${API_URL}/entity-types/${id}/fields/${fieldId}`, {
        method: "DELETE",
      });
      loadFields();
    } catch (err) {
      showAlert(err instanceof Error ? err.message : "Failed to delete field");
    } finally {
      setDeletingFieldId(null);
    }
  }

  function openEditField(field: EntityField): void {
    const opts = field.config.options ?? [];
    const enumRows: EnumRow[] =
      opts.length > 0
        ? opts.map((o) => ({ label: typeof o === "string" ? o : o.label }))
        : [{ label: "" }];
    setEditForm({
      label: field.label,
      isRequired: field.isRequired,
      sortOrder: field.sortOrder,
      enumRows,
    });
    setEditingField(field);
    setEditError(null);
  }

  async function handleSaveField(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!id || !editingField) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {
        label: editForm.label,
        isRequired: editForm.isRequired,
        sortOrder: editForm.sortOrder,
      };
      if (
        editingField.fieldType === "enum" ||
        editingField.fieldType === "multi_enum"
      ) {
        const options = editForm.enumRows
          .filter((r) => r.label.trim())
          .map((r) => ({
            label: r.label.trim(),
            value: labelToValue(r.label),
          }));
        body["config"] = { ...editingField.config, options };
      }
      await fetchWithAuth(
        `${API_URL}/entity-types/${id}/fields/${editingField.id}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      );
      setEditingField(null);
      loadFields();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingEdit(false);
    }
  }

  const entityType = data?.data;
  const sortedFields = [...fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const selectFields = sortedFields.filter(
    (f) =>
      f.fieldType === "enum" ||
      f.fieldType === "multi_enum" ||
      f.fieldType === "select",
  );

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading…</span>
      </div>
    );
  }

  if (!entityType) {
    return (
      <div className="empty-state">
        <h4>Entity type not found</h4>
        <Link
          to="/entity-types"
          className="back-link"
          style={{ marginTop: "12px", display: "inline-block" }}
        >
          ← Back to Entity Types
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "4px",
        }}
      >
        <Link to="/entity-types" className="back-link">
          ← Entity Types
        </Link>
        <Button
          asChild
          variant="secondary"
          style={{
            fontSize: "13px",
            padding: "6px 14px",
            textDecoration: "none",
          }}
        >
          <Link to={`/entity-types/${id ?? ""}/records`}>View Records →</Link>
        </Button>
      </div>

      <div className="detail-header">
        {isRenderableIcon(entityType.icon) ? (
          <span className="detail-icon">{entityType.icon}</span>
        ) : (
          <div className="detail-icon-placeholder">
            {entityType.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div>
          <h2 className="page-title" style={{ marginBottom: "6px" }}>
            {entityType.name}
          </h2>
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "var(--text-muted)", fontSize: "13px" }}>
              plural:{" "}
              <span style={{ color: "var(--text-secondary)" }}>
                {entityType.plural}
              </span>
            </span>
            {entityType.moduleId && (
              <span className="badge badge-primary">{entityType.moduleId}</span>
            )}
            {entityType.allowCustomFields && (
              <span className="badge badge-success">Custom Fields Allowed</span>
            )}
            <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>
              Created {new Date(entityType.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>

      <div className="data-panel">
        <div className="panel-header">
          <h3 className="panel-title">Fields</h3>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <span className="badge badge-muted">{fields.length} fields</span>
            {entityType.allowCustomFields && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowAddField(true)}
              >
                + Add Field
              </Button>
            )}
          </div>
        </div>

        {fieldsLoading ? (
          <div style={{ padding: "32px", textAlign: "center" }}>
            <div className="spinner" style={{ margin: "0 auto" }} />
          </div>
        ) : fieldsError ? (
          <div className="alert alert-error">{fieldsError}</div>
        ) : sortedFields.length === 0 ? (
          <div className="empty-state-inline">
            No fields defined for this entity type.
          </div>
        ) : (
          <Table scroll={false}>
            <TableHeader>
              <TableRow>
                <TableHead style={{ width: "40px" }}>#</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Field Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Required</TableHead>
                <TableHead>Indexed</TableHead>
                <TableHead>System</TableHead>
                <TableHead style={{ width: "48px" }}></TableHead>
                <TableHead style={{ width: "48px" }}></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedFields.map((field) => {
                const style =
                  FIELD_TYPE_STYLE[field.fieldType] ?? FALLBACK_STYLE;
                return (
                  <TableRow key={field.id}>
                    <TableCell
                      style={{ color: "var(--text-muted)", fontSize: "12px" }}
                    >
                      {field.sortOrder}
                    </TableCell>
                    <TableCell style={{ fontWeight: 500 }}>
                      {field.label}
                    </TableCell>
                    <TableCell>
                      <code className="code-inline">{field.name}</code>
                    </TableCell>
                    <TableCell>
                      <span
                        className="badge"
                        style={{
                          backgroundColor: style.bg,
                          color: style.color,
                          border: `1px solid ${style.color}30`,
                        }}
                      >
                        {field.fieldType}
                      </span>
                    </TableCell>
                    <TableCell>
                      {field.isRequired ? (
                        <span className="badge badge-warning">Required</span>
                      ) : (
                        <span className="text-muted-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {field.isIndexed ? (
                        <span className="badge badge-success">Yes</span>
                      ) : (
                        <span className="text-muted-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {field.isSystem ? (
                        <span className="badge badge-muted">System</span>
                      ) : (
                        <span className="text-muted-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <button
                        className="btn-edit-sm"
                        onClick={() => openEditField(field)}
                        title="Edit field"
                      >
                        ✎
                      </button>
                    </TableCell>
                    <TableCell>
                      {!field.isSystem && (
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={deletingFieldId === field.id}
                          onClick={() => {
                            void showConfirm(
                              `Delete field "${field.label}"?`,
                            ).then((confirmed) => {
                              if (confirmed) void handleDeleteField(field.id);
                            });
                          }}
                          title="Delete field"
                        >
                          {deletingFieldId === field.id ? "…" : "✕"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {selectFields.length > 0 && (
        <div className="data-panel">
          <div className="panel-header">
            <h3 className="panel-title">Enum / Select Options</h3>
          </div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: "16px" }}
          >
            {selectFields.map((f) => {
              const opts = f.config.options ?? [];
              return (
                <div key={f.id}>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "var(--text-secondary)",
                      fontWeight: 500,
                      marginBottom: "8px",
                    }}
                  >
                    {f.label}{" "}
                    <code className="code-inline" style={{ marginLeft: "6px" }}>
                      {f.name}
                    </code>
                  </div>
                  <div
                    style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}
                  >
                    {opts.map((opt) => {
                      const label = typeof opt === "string" ? opt : opt.label;
                      const value = typeof opt === "string" ? opt : opt.value;
                      const color =
                        typeof opt === "string" ? undefined : opt.color;
                      return (
                        <span
                          key={value}
                          className="badge badge-muted"
                          style={
                            color
                              ? {
                                  borderLeft: `3px solid ${color}`,
                                  paddingLeft: "6px",
                                }
                              : undefined
                          }
                        >
                          {label}
                        </span>
                      );
                    })}
                    {opts.length === 0 && (
                      <span className="text-muted-sm">
                        No options configured
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Dialog
        open={showAddField}
        onOpenChange={(next) => {
          if (!next) setShowAddField(false);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="modal"
          style={DIALOG_CONTENT_RESET}
        >
          <div className="modal-header">
            <DialogTitle asChild>
              <h3 className="modal-title">Add Field</h3>
            </DialogTitle>
            <DialogClose asChild>
              <button type="button" className="modal-close" aria-label="Close">
                ×
              </button>
            </DialogClose>
          </div>
          <form onSubmit={(e) => void handleAddField(e)}>
            <div className="modal-body">
              {fieldError && (
                <div
                  className="alert alert-error"
                  style={{ marginBottom: "16px" }}
                >
                  {fieldError}
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Label *</label>
                  <input
                    className="form-input"
                    placeholder="e.g. Subject"
                    value={fieldForm.label}
                    onChange={(e) => {
                      const label = e.target.value;
                      const name = label
                        .toLowerCase()
                        .replace(/\s+/g, "_")
                        .replace(/[^a-z0-9_]/g, "");
                      setFieldForm((f) => ({ ...f, label, name }));
                    }}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Field Name *</label>
                  <input
                    className="form-input"
                    placeholder="e.g. subject"
                    value={fieldForm.name}
                    onChange={(e) =>
                      setFieldForm((f) => ({ ...f, name: e.target.value }))
                    }
                    pattern="^[a-z_][a-z0-9_]*$"
                    title="snake_case only"
                    required
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Field Type *</label>
                  <select
                    className="form-input"
                    value={fieldForm.fieldType}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        fieldType: e.target.value as FieldTypeVal,
                      }))
                    }
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Sort Order</label>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={fieldForm.sortOrder}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        sortOrder: parseInt(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
              </div>
              {(fieldForm.fieldType === "enum" ||
                fieldForm.fieldType === "multi_enum") && (
                <div className="form-group">
                  <label className="form-label">Options</label>
                  <EnumOptionsList
                    rows={fieldForm.enumRows}
                    onChange={(rows) =>
                      setFieldForm((f) => ({ ...f, enumRows: rows }))
                    }
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: "24px" }}>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={fieldForm.isRequired}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        isRequired: e.target.checked,
                      }))
                    }
                  />
                  <span>Required</span>
                </label>
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={fieldForm.isIndexed}
                    onChange={(e) =>
                      setFieldForm((f) => ({
                        ...f,
                        isIndexed: e.target.checked,
                      }))
                    }
                  />
                  <span>Indexed</span>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowAddField(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={savingField}>
                {savingField ? "Adding…" : "Add Field"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {/* ── Edit Field Modal ──────────────────────────────────────────── */}
      <Dialog
        open={editingField !== null}
        onOpenChange={(next) => {
          if (!next) setEditingField(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="modal"
          style={DIALOG_CONTENT_RESET}
        >
          <div className="modal-header">
            <DialogTitle asChild>
              <h3 className="modal-title">
                Edit Field — {editingField?.label}
              </h3>
            </DialogTitle>
            <DialogClose asChild>
              <button type="button" className="modal-close" aria-label="Close">
                ×
              </button>
            </DialogClose>
          </div>
          <form onSubmit={(e) => void handleSaveField(e)}>
            <div className="modal-body">
              {editError && (
                <div
                  className="alert alert-error"
                  style={{ marginBottom: "16px" }}
                >
                  {editError}
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Label *</label>
                  <input
                    className="form-input"
                    value={editForm.label}
                    onChange={(e) =>
                      setEditForm((f) => ({ ...f, label: e.target.value }))
                    }
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Sort Order</label>
                  <input
                    className="form-input"
                    type="number"
                    min={0}
                    value={editForm.sortOrder}
                    onChange={(e) =>
                      setEditForm((f) => ({
                        ...f,
                        sortOrder: parseInt(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
              </div>

              {(editingField?.fieldType === "enum" ||
                editingField?.fieldType === "multi_enum") && (
                <div className="form-group">
                  <label className="form-label">Options</label>
                  <EnumOptionsList
                    rows={editForm.enumRows}
                    onChange={(rows) =>
                      setEditForm((f) => ({ ...f, enumRows: rows }))
                    }
                  />
                </div>
              )}

              <label className="form-checkbox">
                <input
                  type="checkbox"
                  checked={editForm.isRequired}
                  onChange={(e) =>
                    setEditForm((f) => ({
                      ...f,
                      isRequired: e.target.checked,
                    }))
                  }
                />
                <span>Required</span>
              </label>
            </div>
            <div className="modal-footer">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditingField(null)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={savingEdit}>
                {savingEdit ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
