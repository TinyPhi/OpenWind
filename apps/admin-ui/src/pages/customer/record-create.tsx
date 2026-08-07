import React, { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { FieldInput } from "../../components/field-input.js";
import { useEntityTypes } from "../../entity-type-context.js";
import { useFileUpload } from "../../hooks/use-file-upload.js";
import {
  AttachmentUploadZone,
  StagedFileChip,
} from "../../components/file-attachment.js";
import { TOKENS, useHoverStyle } from "@platform/ui";

type UserOption = {
  userId: string;
  displayName: string;
  loginName: string;
  email?: string;
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function UnassignedRow({
  onSelect,
}: {
  onSelect: () => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: "" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "9px 12px",
        cursor: "pointer",
        color: "var(--text-tertiary)",
        fontSize: "13px",
        borderBottom: "1px solid var(--border-primary)",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      Unassigned
    </div>
  );
}

function UserOptionRow({
  user,
  isSelected,
  onSelect,
}: {
  user: UserOption;
  isSelected: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const rowHover = useHoverStyle({
    base: { background: isSelected ? TOKENS.bgSecondary : "" },
    hover: { background: TOKENS.bgSecondary },
  });

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "9px 12px",
        cursor: "pointer",
        ...rowHover.style,
      }}
      onMouseEnter={rowHover.onMouseEnter}
      onMouseLeave={rowHover.onMouseLeave}
    >
      <span
        style={{
          width: "30px",
          height: "30px",
          borderRadius: "50%",
          background: "var(--accent-primary)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "11px",
          fontWeight: 600,
          flexShrink: 0,
          opacity: isSelected ? 1 : 0.85,
        }}
      >
        {initials(user.displayName)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 500,
            fontSize: "13px",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.displayName}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.loginName}
        </div>
      </div>
      {isSelected && (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          style={{ flexShrink: 0 }}
        >
          <path
            d="M2 7l3.5 3.5L12 3"
            stroke="var(--accent-primary)"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

function UserPicker({
  users,
  value,
  onChange,
}: {
  users: UserOption[];
  value: string;
  onChange: (userId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = users.find((u) => u.userId === value) ?? null;

  const filtered = query.trim()
    ? users.filter((u) => {
        const q = query.toLowerCase();
        return (
          u.displayName.toLowerCase().includes(q) ||
          u.loginName.toLowerCase().includes(q) ||
          (u.email ?? "").toLowerCase().includes(q)
        );
      })
    : users;

  useEffect(() => {
    function onClickOutside(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handleOpen(): void {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleSelect(userId: string): void {
    onChange(userId);
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
          gap: "10px",
          padding: "9px 12px",
          background: "var(--bg-primary)",
          border: "1.5px solid var(--border-primary)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          textAlign: "left",
          color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
          fontSize: "14px",
          transition: "border-color 0.15s",
        }}
        onFocus={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.borderColor =
            "var(--accent-primary)")
        }
        onBlur={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.borderColor =
            "var(--border-primary)")
        }
      >
        {selected ? (
          <>
            <span
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                background: "var(--accent-primary)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "11px",
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {initials(selected.displayName)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  fontSize: "14px",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selected.displayName}
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-tertiary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {selected.loginName}
              </div>
            </div>
            <span
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              style={{
                marginLeft: "auto",
                color: "var(--text-tertiary)",
                fontSize: "16px",
                lineHeight: 1,
                cursor: "pointer",
                padding: "2px 4px",
                borderRadius: "3px",
              }}
              title="Clear"
            >
              ×
            </span>
          </>
        ) : (
          <span style={{ color: "var(--text-tertiary)" }}>
            Search and assign a user…
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
              padding: "8px",
              borderBottom: "1px solid var(--border-primary)",
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder="Search by name or username…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%",
                padding: "7px 10px",
                border: "1.5px solid var(--border-primary)",
                borderRadius: "var(--radius-sm)",
                fontSize: "13px",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div style={{ maxHeight: "220px", overflowY: "auto" }}>
            <UnassignedRow onSelect={() => handleSelect("")} />
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "12px",
                  textAlign: "center",
                  color: "var(--text-tertiary)",
                  fontSize: "13px",
                }}
              >
                No users found
              </div>
            ) : (
              filtered.map((u) => (
                <UserOptionRow
                  key={u.userId}
                  user={u}
                  isSelected={u.userId === value}
                  onSelect={() => handleSelect(u.userId)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isSystem: boolean;
  config: {
    options?: Array<string | { label: string; value: string; color?: string }>;
    allowedCurrencies?: string[];
  };
};
type WorkflowDef = {
  id: string;
  name: string;
  initialState: string;
  states?: Array<{ id: string; name: string; label: string }>;
};

export function CustomerRecordCreate(): React.ReactElement {
  const { typeSlug } = useParams<{ typeSlug: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = (location.state ?? {}) as {
    workflowId?: string;
    entityTypeId?: string;
    returnTo?: string;
  };
  const { getTypeBySlug, getTypeById } = useEntityTypes();
  // Prefer the explicit entityTypeId from router state (set by WorkflowRecords) —
  // it is authoritative and avoids slug ambiguity when multiple entity types share
  // the same slug. Fall back to slug matching for direct URL access.
  const entityType =
    (routeState.entityTypeId
      ? getTypeById(routeState.entityTypeId)
      : undefined) ?? (typeSlug ? getTypeBySlug(typeSlug) : undefined);
  const entityTypeId = entityType?.id ?? routeState.entityTypeId;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [workflowId, setWorkflowId] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { stagedFiles, addFiles, removeFile, pendingCount, cleanFileIds } =
    useFileUpload({ moduleSlug: typeSlug ?? "unknown" });

  const currentWorkflowName = workflows.find((w) => w.id === workflowId)?.name;

  useEffect(() => {
    if (workflowId) {
      const wf = workflows.find((w) => w.id === workflowId);
      if (wf) {
        const isValid = wf.states?.some((s) => s.name === currentState);
        if (!isValid) {
          // Only use initialState if it still exists; otherwise pick first state
          const fallback =
            wf.states?.find((s) => s.name === wf.initialState)?.name ??
            wf.states?.[0]?.name ??
            "";
          setCurrentState(fallback);
        }
      }
    } else {
      setCurrentState("");
    }
  }, [workflowId, workflows]);

  useEffect(() => {
    if (!entityTypeId) return;
    // cancelled prevents a stale response (from React Strict Mode's double-invoke
    // or a rapid entityTypeId change) from overwriting state set by the current fetch.
    let cancelled = false;
    Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(
        `${API_URL}/workflows?${new URLSearchParams({ entityTypeId }).toString()}`,
      ),
      fetchWithAuth(`${API_URL}/users`),
    ])
      .then(([fieldsRes, wfRes, usersRes]) => {
        if (cancelled) return;
        const fs = (fieldsRes as { data: EntityField[] }).data;
        setFields(fs);
        const wfs = (wfRes as { data?: WorkflowDef[] }).data ?? [];
        setWorkflows(wfs);
        const preselect = routeState.workflowId;
        if (preselect && wfs.some((w) => w.id === preselect)) {
          setWorkflowId(preselect);
        } else if (wfs.length === 1 && wfs[0]) {
          setWorkflowId(wfs[0].id);
        }
        const usrs = (usersRes as { data?: UserOption[] }).data ?? [];
        setUsers(usrs);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityTypeId]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!entityTypeId || !typeSlug) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        entityTypeId,
        fields: fieldValues,
      };
      if (workflowId) payload["workflowId"] = workflowId;
      if (currentState) payload["currentState"] = currentState;
      if (assignedTo) payload["assignedTo"] = assignedTo;
      if (dueDate) payload["dueDate"] = new Date(dueDate).toISOString();
      const res = await fetchWithAuth(`${API_URL}/entities`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const created = (res as { data: { id: string } }).data;
      for (const fileId of cleanFileIds) {
        try {
          await fetchWithAuth(`${API_URL}/entities/${created.id}/attachments`, {
            method: "POST",
            body: JSON.stringify({ fileId }),
          });
        } catch {
          // Record was created; a single attachment failing to bind
          // shouldn't block navigation — it can be re-attached from the
          // detail page.
        }
      }
      if (routeState.returnTo) {
        navigate(routeState.returnTo);
      } else {
        navigate(`/records/${typeSlug}/${created.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSaving(false);
    }
  }

  if (loading)
    return (
      <div className="portal-loading">
        <div className="spinner" />
      </div>
    );

  return (
    <div className="portal-page">
      <button
        type="button"
        className="portal-back-link"
        onClick={() => navigate(-1)}
      >
        ← {entityType?.plural ?? "Records"}
      </button>
      <h1 className="portal-page-title">
        {currentWorkflowName
          ? `Create New Ticket in '${currentWorkflowName}'`
          : `New ${entityType?.name ?? "Ticket"}`}
      </h1>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="portal-form"
        style={{ marginTop: "24px" }}
      >
        {error && <div className="portal-alert-error">{error}</div>}
        {workflows.length > 0 && (
          <div className="portal-field-group">
            <label className="portal-field-label">Workflow</label>
            <select
              className="portal-input"
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value)}
            >
              <option value="">No workflow</option>
              {workflows.map((wf) => (
                <option key={wf.id} value={wf.id}>
                  {wf.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="portal-field-group">
          <label className="portal-field-label">Assigned To</label>
          <UserPicker
            users={users}
            value={assignedTo}
            onChange={setAssignedTo}
          />
        </div>
        <div className="portal-field-group">
          <label className="portal-field-label">Due Date</label>
          <input
            type="datetime-local"
            className="portal-input"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        {fields.map((field) => (
          <div key={field.id} className="portal-field-group">
            <label className="portal-field-label">
              {field.label}
              {field.isRequired && <span className="portal-required">*</span>}
            </label>
            <FieldInput
              field={field}
              value={fieldValues[field.name]}
              classPrefix="portal"
              required={field.isRequired}
              moduleSlug={typeSlug ?? "unknown"}
              entityId={undefined}
              onChange={(v) =>
                setFieldValues((p) => ({ ...p, [field.name]: v }))
              }
            />
          </div>
        ))}
        {fields.length === 0 && (
          <p className="portal-text-muted">
            No fields defined for this entity type.
          </p>
        )}
        <div className="portal-field-group">
          <label className="portal-field-label">Attachments</label>
          {stagedFiles.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px",
                marginBottom: "8px",
              }}
            >
              {stagedFiles.map((f) => (
                <StagedFileChip key={f.fileId} file={f} onRemove={removeFile} />
              ))}
            </div>
          )}
          <AttachmentUploadZone onFiles={(files) => addFiles(files)} />
        </div>
        <div className="portal-form-actions">
          <button
            type="button"
            className="portal-btn-secondary"
            onClick={() => navigate(-1)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="portal-btn-primary"
            disabled={saving || pendingCount > 0}
            title={pendingCount > 0 ? "Waiting for file scan…" : undefined}
          >
            {saving ? "Creating…" : "Create Ticket"}
          </button>
        </div>
      </form>
    </div>
  );
}
