import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes, toTypeSlug } from "../../entity-type-context.js";
import { FieldInput } from "../../components/field-input.js";
import { Button } from "@platform/ui";

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

type EntityTypeMeta = {
  id: string;
  name: string;
  plural: string;
};

export function EntityInstanceCreate(): React.ReactElement {
  const { id: entityTypeId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getTypeById, modules } = useEntityTypes();
  const moduleSlug =
    modules.find((m) => m.id === getTypeById(entityTypeId ?? "")?.moduleId)
      ?.slug ?? "platform";

  const [entityType, setEntityType] = useState<EntityTypeMeta | null>(null);
  const [fields, setFields] = useState<EntityField[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [users, setUsers] = useState<
    Array<{
      userId: string;
      displayName: string;
      loginName: string;
      email?: string;
    }>
  >([]);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [workflowId, setWorkflowId] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const availableStates = selectedWorkflow?.states ?? [];

  // Sync currentState when workflow selection changes
  useEffect(() => {
    if (!workflowId) {
      setCurrentState("");
      return;
    }
    const wf = workflows.find((w) => w.id === workflowId);
    if (!wf) return;
    const isValid = wf.states?.some((s) => s.name === currentState);
    if (!isValid) {
      setCurrentState(
        wf.states?.find((s) => s.name === wf.initialState)?.name ??
          wf.states?.[0]?.name ??
          "",
      );
    }
  }, [workflowId, workflows]);

  useEffect(() => {
    if (!entityTypeId) return;
    Promise.all([
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}`),
      fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}/fields`),
      fetchWithAuth(
        `${API_URL}/workflows?${new URLSearchParams({ entityTypeId }).toString()}`,
      ),
      fetchWithAuth(`${API_URL}/users`),
    ])
      .then(([etRes, fieldsRes, wfRes, usersRes]) => {
        setEntityType((etRes as { data: EntityTypeMeta }).data);
        setFields(
          (fieldsRes as { data: EntityField[] }).data.filter(
            (f) => !f.isSystem,
          ),
        );
        const wfs = (wfRes as { data?: WorkflowDef[] }).data ?? [];
        setWorkflows(wfs);
        if (wfs.length === 1 && wfs[0]) setWorkflowId(wfs[0].id);

        const usrs =
          (
            usersRes as {
              data?: Array<{
                userId: string;
                displayName: string;
                loginName: string;
                email?: string;
              }>;
            }
          ).data ?? [];
        setUsers(usrs);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [entityTypeId]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!entityTypeId) return;
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
      const et = getTypeById(entityTypeId);
      const slug = et ? toTypeSlug(et.name) : entityTypeId;
      navigate(`/records/${slug}/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
      setSaving(false);
    }
  }

  if (loading)
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading…</span>
      </div>
    );

  const typeName = entityType?.name ?? "Record";

  return (
    <div style={{ maxWidth: "720px" }}>
      <div style={{ marginBottom: "8px" }}>
        <Link
          to={`/entity-types/${entityTypeId ?? ""}`}
          className="breadcrumb-link"
        >
          ← {entityType?.plural ?? "Records"}
        </Link>
      </div>

      <h2 className="page-title" style={{ marginBottom: "24px" }}>
        New {typeName}
      </h2>

      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="data-panel"
        style={{ padding: "24px" }}
      >
        {error && (
          <div className="alert alert-error" style={{ marginBottom: "16px" }}>
            {error}
          </div>
        )}

        {workflows.length > 0 && (
          <div className="form-group">
            <label className="form-label">Workflow</label>
            <select
              className="form-input"
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
          <div className="form-group">
            <label className="form-label">Initial State</label>
            <select
              className="form-input"
              value={currentState}
              onChange={(e) => setCurrentState(e.target.value)}
            >
              {availableStates.map((st) => (
                <option key={st.id} value={st.name}>
                  {st.label || st.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Assigned To</label>
          <select
            className="form-input"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.loginName
                  ? `${u.loginName} (${u.email ?? u.userId})`
                  : u.displayName}
              </option>
            ))}
          </select>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            marginTop: workflows.length > 0 ? "8px" : "0",
          }}
        >
          {fields.map((f) => (
            <div
              key={f.id}
              style={f.fieldType === "longtext" ? { gridColumn: "1 / -1" } : {}}
              className="form-group"
            >
              <label className="form-label">
                {f.label}
                {f.isRequired && (
                  <span style={{ color: "var(--danger)" }}> *</span>
                )}
              </label>
              <FieldInput
                field={f}
                value={fieldValues[f.name]}
                required={f.isRequired}
                moduleSlug={moduleSlug}
                entityId={undefined}
                onChange={(v) => setFieldValues((p) => ({ ...p, [f.name]: v }))}
              />
            </div>
          ))}
        </div>

        {fields.length === 0 && (
          <p style={{ color: "var(--text-muted)", margin: "8px 0 16px" }}>
            No fields defined for this entity type.
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            marginTop: "24px",
          }}
        >
          <Button asChild variant="secondary">
            <Link to={`/entity-types/${entityTypeId ?? ""}`}>Cancel</Link>
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Creating…" : `Create ${typeName}`}
          </Button>
        </div>
      </form>
    </div>
  );
}
