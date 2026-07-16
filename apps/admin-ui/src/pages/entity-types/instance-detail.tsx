import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { UserPicker } from "../../components/user-picker.js";

type EntityField = {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isSystem: boolean;
  isRequired: boolean;
  config: {
    options?: Array<string | { label: string; value: string; color?: string }>;
  };
};

type EntityInstance = {
  id: string;
  workflowId: string | null;
  currentState: string | null;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  assignedTo: string | null;
};

type WorkflowEvent = {
  id: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  comment: string | null;
  triggeredAt: string;
  metadata?: Record<string, unknown>;
};

type WorkflowState = {
  id: string;
  name: string;
  label: string;
  color: string | null;
  isTerminal: boolean;
};

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("amount" in obj && "currency" in obj)
      return `${String(obj.currency)} ${String(obj.amount)}`;
    return JSON.stringify(value);
  }
  return String(value);
}

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
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    case "number":
    case "currency":
      return (
        <input
          className="form-input"
          type="number"
          value={strVal}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      );
    case "date":
      return (
        <input
          className="form-input"
          type="date"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case "datetime":
      return (
        <input
          className="form-input"
          type="datetime-local"
          value={strVal}
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
          className="form-input"
          value={strVal}
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
          className="form-input"
          value={strVal}
          rows={4}
          style={{ resize: "vertical" }}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    default:
      return (
        <input
          className="form-input"
          type="text"
          value={strVal}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

export function EntityInstanceDetail(): React.ReactElement {
  const { id: entityTypeId, instanceId } = useParams<{
    id: string;
    instanceId: string;
  }>();

  const [fields, setFields] = useState<EntityField[]>([]);
  const [record, setRecord] = useState<EntityInstance | null>(null);
  const [history, setHistory] = useState<WorkflowEvent[]>([]);
  const [allStates, setAllStates] = useState<WorkflowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [currentState, setCurrentState] = useState("");
  const [users, setUsers] = useState<
    Array<{ userId: string; email: string; displayName: string | null }>
  >([]);

  const getFieldLabel = (fieldName: string): string => {
    if (fieldName === "state" || fieldName === "currentState") return "State";
    if (fieldName === "assignedTo") return "Assigned To";
    const found = fields.find((f) => f.name === fieldName);
    return found ? found.label : fieldName;
  };

  const getActorName = (actorId: string | null): string => {
    if (!actorId) return "System";
    const u = users.find((user) => user.userId === actorId);
    return u?.displayName ?? u?.email ?? actorId;
  };

  const [savingAssign, setSavingAssign] = useState(false);

  async function handleAssign(userId: string | null): Promise<void> {
    if (!instanceId) return;
    setSavingAssign(true);
    try {
      await fetchWithAuth(`${API_URL}/entities/${instanceId}`, {
        method: "PATCH",
        body: JSON.stringify({ assignedTo: userId }),
      });
      setLoading(true);
      void loadRecord();
    } catch {
      // ignore — record stays as-is
    } finally {
      setSavingAssign(false);
    }
  }

  const [stateModal, setStateModal] = useState(false);
  const [selectedState, setSelectedState] = useState("");
  const [stateComment, setStateComment] = useState("");
  const [settingState, setSettingState] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  function loadRecord(): Promise<void> {
    if (!entityTypeId || !instanceId) return Promise.resolve();
    return Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(`${API_URL}/entities/${instanceId}`),
      fetchWithAuth(
        `${API_URL}/entities/${instanceId}/transitions/history`,
      ).catch(() => ({ data: [] })),
      fetchWithAuth(`${API_URL}/users`).catch(() => ({ data: [] })),
    ])
      .then(([fieldsRes, recRes, histRes, usersRes]) => {
        setFields(
          ((fieldsRes as { data?: EntityField[] }).data ?? []).filter(
            (f) => !f.isSystem,
          ),
        );
        const rec = (recRes as { data: EntityInstance }).data;
        setRecord(rec);
        setHistory((histRes as { data?: WorkflowEvent[] }).data ?? []);
        setUsers(
          (
            usersRes as {
              data?: Array<{
                userId: string;
                email: string;
                displayName: string | null;
              }>;
            }
          ).data ?? [],
        );
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }

  async function loadStates(workflowId: string): Promise<void> {
    try {
      const res = await fetchWithAuth(`${API_URL}/workflows/${workflowId}`);
      const wf = (res as { data: { states: WorkflowState[] } }).data;
      setAllStates((wf as { states?: WorkflowState[] }).states ?? []);
    } catch {
      // ignore — states panel just stays empty
    }
  }

  useEffect(() => {
    void loadRecord();
  }, [entityTypeId, instanceId]);

  // Load workflow states once record is loaded or entity type is known
  useEffect(() => {
    if (record?.workflowId) {
      void loadStates(record.workflowId);
      return;
    }
    if (!entityTypeId) return;
    const params = new URLSearchParams({ entityTypeId });
    void fetchWithAuth(`${API_URL}/workflows?${params.toString()}`)
      .then((res) => {
        const wfs = (res as { data?: Array<{ id: string }> }).data ?? [];
        if (wfs[0]?.id) void loadStates(wfs[0].id);
      })
      .catch(() => undefined);
  }, [record?.workflowId, entityTypeId]);

  async function saveEdit(): Promise<void> {
    if (!instanceId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await fetchWithAuth(`${API_URL}/entities/${instanceId}`, {
        method: "PATCH",
        body: JSON.stringify({ fields: editValues, currentState }),
      });
      setEditing(false);
      setLoading(true);
      void loadRecord();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSetState(): Promise<void> {
    if (!instanceId || !selectedState) return;
    setSettingState(true);
    setStateError(null);
    try {
      await fetchWithAuth(`${API_URL}/entities/${instanceId}/state`, {
        method: "POST",
        body: JSON.stringify({ state: selectedState }),
      });
      setStateModal(false);
      setSelectedState("");
      setStateComment("");
      setLoading(true);
      void loadRecord();
    } catch (err) {
      setStateError(
        err instanceof Error ? err.message : "Failed to update state",
      );
    } finally {
      setSettingState(false);
    }
  }

  function stateBadge(state: string | null): React.ReactElement {
    if (!state) return <span style={{ color: "var(--text-muted)" }}>—</span>;
    const colors: Record<string, string> = {
      new: "#6b7280",
      open: "#3b82f6",
      in_progress: "#f59e0b",
      waiting_for_customer: "#8b5cf6",
      resolved: "#10b981",
      closed: "#6b7280",
      pending: "#8b5cf6",
    };
    const color = colors[state] ?? "#6b7280";
    return (
      <span
        style={{
          padding: "3px 12px",
          borderRadius: "4px",
          fontSize: "12px",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.4px",
          background: `${color}22`,
          color,
          border: `1px solid ${color}44`,
        }}
      >
        {state.replace(/_/g, " ")}
      </span>
    );
  }

  if (loading)
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading…</span>
      </div>
    );
  if (error || !record)
    return (
      <div className="alert alert-error">{error ?? "Record not found"}</div>
    );

  return (
    <div style={{ maxWidth: "860px" }}>
      {/* Breadcrumb */}
      <div style={{ marginBottom: "8px" }}>
        <Link
          to={`/entity-types/${entityTypeId ?? ""}/records`}
          className="breadcrumb-link"
        >
          ← Records
        </Link>
      </div>

      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "24px",
        }}
      >
        <div>
          <h2
            className="page-title"
            style={{ display: "flex", alignItems: "center", gap: "12px" }}
          >
            Record detail
            {stateBadge(record.currentState)}
          </h2>
          <p className="page-subtitle" style={{ fontSize: "12px" }}>
            ID:{" "}
            <code style={{ fontSize: "11px", opacity: 0.7 }}>{record.id}</code>{" "}
            · Created {new Date(record.createdAt).toLocaleString()} · Updated{" "}
            {new Date(record.updatedAt).toLocaleString()}
          </p>
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button className="btn-secondary" onClick={() => setStateModal(true)}>
            Change State
          </button>
          {!editing && (
            <button
              className="btn-primary"
              onClick={() => {
                setEditValues(record.fields);
                setCurrentState(record.currentState ?? "");
                setEditing(true);
                setSaveError(null);
              }}
            >
              Edit Fields
            </button>
          )}
        </div>
      </div>

      {/* Assign To */}
      <div
        className="data-panel"
        style={{
          marginBottom: "24px",
          display: "flex",
          alignItems: "center",
          gap: "16px",
          padding: "14px 20px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            minWidth: "90px",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-secondary)",
            }}
          >
            Assigned To
          </span>
        </div>
        <UserPicker
          users={users.map((u) => ({
            userId: u.userId,
            displayName: u.displayName ?? u.email,
            email: u.email,
          }))}
          value={record.assignedTo}
          onChange={(uid) => void handleAssign(uid)}
          placeholder="Assign to a user…"
          disabled={savingAssign}
        />
        {savingAssign && (
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Saving…
          </span>
        )}
        {!savingAssign && record.assignedTo && (
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Assigned user has edit access to this record.
          </span>
        )}
      </div>

      {/* Fields card */}
      <div className="data-panel" style={{ marginBottom: "24px" }}>
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 600 }}>Fields</span>
          {editing && (
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                className="btn-secondary"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={() => void saveEdit()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
        {saveError && (
          <div className="alert alert-error" style={{ margin: "12px 20px 0" }}>
            {saveError}
          </div>
        )}
        <div style={{ padding: "20px" }}>
          {fields.length === 0 ? (
            <p style={{ color: "var(--text-muted)" }}>No fields defined.</p>
          ) : editing ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "16px",
              }}
            >
              {allStates.length > 0 && (
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="form-label">State</label>
                  <select
                    className="form-input"
                    value={currentState}
                    onChange={(e) => setCurrentState(e.target.value)}
                  >
                    {allStates.map((st) => (
                      <option key={st.id} value={st.name}>
                        {st.label || st.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {fields.map((f) => (
                <div
                  key={f.id}
                  style={
                    f.fieldType === "longtext" ? { gridColumn: "1 / -1" } : {}
                  }
                >
                  <label className="form-label">
                    {f.label}
                    {f.isRequired && (
                      <span style={{ color: "var(--danger)" }}> *</span>
                    )}
                  </label>
                  <FieldInput
                    field={f}
                    value={editValues[f.name]}
                    onChange={(v) =>
                      setEditValues((p) => ({ ...p, [f.name]: v }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "0",
              }}
            >
              {fields.map((f) => (
                <div
                  key={f.id}
                  style={{
                    padding: "10px 0",
                    borderBottom: "1px solid var(--border)",
                    gridColumn: f.fieldType === "longtext" ? "1 / -1" : "auto",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                      marginBottom: "4px",
                    }}
                  >
                    {f.label}
                  </div>
                  <div style={{ fontSize: "14px" }}>
                    {record.fields[f.name] === null ||
                    record.fields[f.name] === undefined ? (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    ) : (
                      String(record.fields[f.name])
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="data-panel">
          <div
            style={{
              padding: "16px 20px",
              borderBottom: "1px solid var(--border)",
              fontWeight: 600,
            }}
          >
            State History
          </div>
          <div style={{ padding: "16px 20px" }}>
            {history.map((ev) => {
              const meta = ev.metadata;
              const isCreate = meta?.["type"] === "create";
              const isUpdate = meta?.["type"] === "update";

              return (
                <div
                  key={ev.id}
                  style={{
                    display: "flex",
                    gap: "12px",
                    marginBottom: "16px",
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: "var(--accent)",
                      marginTop: "5px",
                      flexShrink: 0,
                    }}
                  />
                  <div>
                    {isCreate ? (
                      <div style={{ fontWeight: 600, color: "var(--text)" }}>
                        🆕 Record created{" "}
                        <span
                          style={{
                            fontWeight: 400,
                            color: "var(--text-muted)",
                            marginLeft: "4px",
                          }}
                        >
                          by {getActorName(ev.actorId)}
                        </span>
                      </div>
                    ) : isUpdate ? (
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            color: "var(--text)",
                            marginBottom: "4px",
                          }}
                        >
                          ✏️ Record updated{" "}
                          <span
                            style={{
                              fontWeight: 400,
                              color: "var(--text-muted)",
                              marginLeft: "4px",
                            }}
                          >
                            by {getActorName(ev.actorId)}
                          </span>
                        </div>
                        {"changed" in meta &&
                        typeof meta["changed"] === "object" &&
                        meta["changed"] !== null &&
                        Object.keys(meta["changed"] as object).length > 0 ? (
                          <ul
                            style={{
                              margin: "4px 0 0 16px",
                              padding: 0,
                              fontSize: "12px",
                              color: "var(--text-secondary)",
                            }}
                          >
                            {Object.entries(
                              meta["changed"] as Record<
                                string,
                                Record<string, unknown>
                              >,
                            ).map(([fieldName, change]) => (
                              <li
                                key={fieldName}
                                style={{ listStyleType: "disc" }}
                              >
                                <strong>{getFieldLabel(fieldName)}</strong>:
                                changed from{" "}
                                <em>{formatFieldValue(change["old"])}</em> to{" "}
                                <em>{formatFieldValue(change["new"])}</em>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        {ev.fromState && (
                          <>
                            {stateBadge(ev.fromState)}{" "}
                            <span style={{ color: "var(--text-muted)" }}>
                              →
                            </span>
                          </>
                        )}
                        {stateBadge(ev.toState)}
                        <span
                          style={{
                            marginLeft: "4px",
                            fontSize: "12px",
                            color: "var(--text-muted)",
                          }}
                        >
                          by {getActorName(ev.actorId)}
                        </span>
                      </div>
                    )}
                    {ev.comment && !isCreate && !isUpdate && (
                      <p
                        style={{
                          marginTop: "4px",
                          fontSize: "13px",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {ev.comment}
                      </p>
                    )}
                    <p
                      style={{
                        marginTop: "4px",
                        fontSize: "12px",
                        color: "var(--text-muted)",
                      }}
                    >
                      {new Date(ev.triggeredAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Change state modal */}
      {stateModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setStateModal(false);
            setStateError(null);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Change State</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setStateModal(false);
                  setStateError(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              {stateError && (
                <div
                  className="alert alert-error"
                  style={{ marginBottom: "12px" }}
                >
                  {stateError}
                </div>
              )}
              <div className="form-group">
                <label className="form-label">
                  Current: {stateBadge(record.currentState)}
                </label>
              </div>
              <div className="form-group">
                <label className="form-label">Move to *</label>
                {allStates.length > 0 ? (
                  <select
                    className="form-input"
                    value={selectedState}
                    onChange={(e) => setSelectedState(e.target.value)}
                  >
                    <option value="">Select a state…</option>
                    {allStates
                      .filter((s) => s.name !== record.currentState)
                      .map((s) => (
                        <option key={s.id} value={s.name}>
                          {s.label || s.name}
                        </option>
                      ))}
                  </select>
                ) : (
                  <input
                    className="form-input"
                    placeholder="e.g. in_progress"
                    value={selectedState}
                    onChange={(e) => setSelectedState(e.target.value)}
                  />
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Note (optional)</label>
                <textarea
                  className="form-input"
                  rows={3}
                  style={{ resize: "vertical" }}
                  placeholder="Reason for state change…"
                  value={stateComment}
                  onChange={(e) => setStateComment(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn-secondary"
                onClick={() => {
                  setStateModal(false);
                  setStateError(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!selectedState || settingState}
                onClick={() => void handleSetState()}
              >
                {settingState ? "Updating…" : "Update State"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
