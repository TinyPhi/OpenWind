import React, { useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes } from "../../entity-type-context.js";

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
            <div
              onClick={() => handleSelect("")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "9px 12px",
                cursor: "pointer",
                color: "var(--text-tertiary)",
                fontSize: "13px",
                borderBottom: "1px solid var(--border-primary)",
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLDivElement).style.background =
                  "var(--bg-secondary)")
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLDivElement).style.background = "")
              }
            >
              Unassigned
            </div>
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
                <div
                  key={u.userId}
                  onClick={() => handleSelect(u.userId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "9px 12px",
                    cursor: "pointer",
                    background: u.userId === value ? "var(--bg-secondary)" : "",
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      "var(--bg-secondary)")
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLDivElement).style.background =
                      u.userId === value ? "var(--bg-secondary)" : "")
                  }
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
                      opacity: u.userId === value ? 1 : 0.85,
                    }}
                  >
                    {initials(u.displayName)}
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
                      {u.displayName}
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
                      {u.loginName}
                    </div>
                  </div>
                  {u.userId === value && (
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

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: EntityField;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.ReactElement {
  const strVal = value === null || value === undefined ? "" : String(value);
  switch (field.fieldType) {
    case "boolean":
      return (
        <label className="portal-checkbox">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    case "number":
      return (
        <input
          className="portal-input"
          type="number"
          value={strVal}
          required={field.isRequired}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "currency": {
      const currVal =
        value !== null && typeof value === "object"
          ? (value as { amount?: unknown; currency?: unknown })
          : { amount: "", currency: "" };
      const amountStr =
        currVal.amount === null || currVal.amount === undefined
          ? ""
          : String(currVal.amount);
      const currencyStr =
        currVal.currency === null || currVal.currency === undefined
          ? ""
          : String(currVal.currency);
      const allowed = field.config.allowedCurrencies ?? [];
      const currencies =
        allowed.length > 0 ? allowed : ["USD", "EUR", "GBP", "INR", "AED"];
      return (
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            className="portal-input"
            type="number"
            placeholder="0.00"
            value={amountStr}
            required={field.isRequired}
            style={{ flex: 1 }}
            onChange={(e) =>
              onChange({
                amount: e.target.value === "" ? null : Number(e.target.value),
                currency: currencyStr || currencies[0],
              })
            }
          />
          <select
            className="portal-input"
            value={currencyStr || currencies[0]}
            style={{ width: "90px" }}
            onChange={(e) =>
              onChange({
                amount: amountStr === "" ? null : Number(amountStr),
                currency: e.target.value,
              })
            }
          >
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case "date":
      return (
        <input
          className="portal-input"
          type="date"
          value={strVal}
          required={field.isRequired}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "datetime":
      return (
        <input
          className="portal-input"
          type="datetime-local"
          value={strVal}
          required={field.isRequired}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "enum":
    case "multi_enum": {
      const opts = (field.config.options ?? []).map((o) =>
        typeof o === "string"
          ? { label: o, value: o }
          : { label: o.label, value: o.value },
      );
      return (
        <select
          className="portal-input"
          value={strVal}
          required={field.isRequired}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">Select…</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case "longtext":
      return (
        <textarea
          className="portal-input portal-textarea"
          value={strVal}
          required={field.isRequired}
          onChange={(e) => onChange(e.target.value || null)}
          rows={4}
        />
      );
    default:
      return (
        <input
          className="portal-input"
          type="text"
          value={strVal}
          required={field.isRequired}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

export function CustomerRecordCreate(): React.ReactElement {
  const { typeSlug } = useParams<{ typeSlug: string }>();
  const navigate = useNavigate();
  const { getTypeBySlug } = useEntityTypes();
  const entityType = typeSlug ? getTypeBySlug(typeSlug) : undefined;
  const entityTypeId = entityType?.id;

  const [fields, setFields] = useState<EntityField[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [workflowId, setWorkflowId] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const availableStates = selectedWorkflow?.states ?? [];

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
    Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(
        `${API_URL}/workflows?${new URLSearchParams({ entityTypeId }).toString()}`,
      ),
      fetchWithAuth(`${API_URL}/users`),
    ])
      .then(([fieldsRes, wfRes, usersRes]) => {
        const fs = (fieldsRes as { data: EntityField[] }).data.filter(
          (f) => !f.isSystem,
        );
        setFields(fs);
        const wfs = (wfRes as { data?: WorkflowDef[] }).data ?? [];
        setWorkflows(wfs);
        if (wfs.length === 1 && wfs[0]) setWorkflowId(wfs[0].id);

        const usrs = (usersRes as { data?: UserOption[] }).data ?? [];
        setUsers(usrs);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
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
      const res = await fetchWithAuth(`${API_URL}/entities`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const created = (res as { data: { id: string } }).data;
      navigate(`/records/${typeSlug}/${created.id}`);
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
      <Link to={`/records/${typeSlug ?? ""}`} className="portal-back-link">
        ← {entityType?.plural ?? "Records"}
      </Link>
      <h1 className="portal-page-title">New {entityType?.name}</h1>
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
        {workflowId && availableStates.length > 0 && (
          <div className="portal-field-group">
            <label className="portal-field-label">State</label>
            <select
              className="portal-input"
              value={currentState}
              onChange={(e) => setCurrentState(e.target.value)}
            >
              {availableStates.map((st) => (
                <option key={st.id} value={st.name}>
                  {st.label}
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
        {fields.map((field) => (
          <div key={field.id} className="portal-field-group">
            <label className="portal-field-label">
              {field.label}
              {field.isRequired && <span className="portal-required">*</span>}
            </label>
            <FieldInput
              field={field}
              value={fieldValues[field.name]}
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
        <div className="portal-form-actions">
          <Link
            to={`/records/${typeSlug ?? ""}`}
            className="portal-btn-secondary"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="portal-btn-primary"
            disabled={saving}
          >
            {saving ? "Creating…" : `Create ${entityType?.name ?? "Record"}`}
          </button>
        </div>
      </form>
    </div>
  );
}
