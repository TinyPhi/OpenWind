import React, { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { useEntityTypes, toTypeSlug } from "../../entity-type-context.js";
import { FieldInput } from "../../components/field-input.js";
import { UserPicker } from "../../components/user-picker.js";
import {
  SeverityDropdown,
  DEFAULT_SEVERITY,
  type Severity,
} from "../../components/severity-tag.js";
import { Button } from "@platform/ui";

// Derives a singular display label from the entity type's plural (e.g.
// "NSI Amendment Requests" -> "NSI Amendment Request") rather than falling
// back to entityType.name, which for several entity types is a raw
// snake_case/lowercase identifier (e.g. "nsi_amendment_request", "ticket")
// never meant for display.
function singularize(plural: string): string {
  if (/[a-z]ies$/.test(plural)) return plural.replace(/ies$/, "y");
  if (/s$/i.test(plural)) return plural.replace(/s$/i, "");
  return plural;
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

type EntityTypeMeta = {
  id: string;
  name: string;
  plural: string;
};

// docs/specs/team-assign-oncall-fallback.md R1/§I.
type TeamOption = {
  id: string;
  name: string;
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
      email: string;
    }>
  >([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [workflowId, setWorkflowId] = useState("");
  const [currentState, setCurrentState] = useState("");
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  // docs/specs/team-assign-oncall-fallback.md R1 — exactly one of user/team.
  const [assignMode, setAssignMode] = useState<"user" | "team">("user");
  const [teamId, setTeamId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [remark, setRemark] = useState("");
  const [severity, setSeverity] = useState<Severity>(DEFAULT_SEVERITY);
  // Mandate = the generic system fields (assigned to, due date, remark,
  // severity) plus whichever custom fields this workflow marks required
  // (conventionally just "title") -- Other = everything else, optional,
  // quick-reference only. Mirrors the tracking-only pivot's field model.
  const [activeTab, setActiveTab] = useState<"mandate" | "other">("mandate");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const availableStates = selectedWorkflow?.states ?? [];
  const mandateFields = fields.filter((f) => f.isRequired);
  // team_id is excluded here (docs/specs/team-assign-oncall-fallback.md R2)
  // -- it is exclusively set through the User/Team toggle below, never
  // independently editable as a normal Other-tab custom field.
  const otherFields = fields.filter(
    (f) => !f.isRequired && f.name !== "team_id",
  );

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
      fetchWithAuth(`${API_URL}/admin/teams`),
    ])
      .then(([etRes, fieldsRes, wfRes, usersRes, teamsRes]) => {
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
                email: string;
              }>;
            }
          ).data ?? [];
        setUsers(usrs);
        const tms = (teamsRes as { data?: TeamOption[] }).data ?? [];
        setTeams(tms);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load"),
      )
      .finally(() => setLoading(false));
  }, [entityTypeId]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!entityTypeId) return;
    // Mandatory platform-wide invariant, mirrored client-side as defense in
    // depth -- POST /entities rejects a request missing any of these
    // regardless, but blocking here avoids a round-trip and points the
    // agent at the Mandate tab instead of a raw server error.
    // docs/specs/team-assign-oncall-fallback.md R1 — exactly one of
    // assignedTo/teamId, driven by assignMode.
    const assignValue = assignMode === "user" ? assignedTo : teamId;
    if (!assignValue || !dueDate || !remark.trim()) {
      setError(
        assignMode === "user"
          ? "Assigned To, Due Date, and Remark are required."
          : "Team, Due Date, and Remark are required.",
      );
      setActiveTab("mandate");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        entityTypeId,
        fields: fieldValues,
        dueDate: new Date(dueDate).toISOString(),
        remark: remark.trim(),
        severity,
      };
      if (assignMode === "user") {
        payload["assignedTo"] = assignedTo;
      } else {
        payload["teamId"] = teamId;
      }
      if (workflowId) payload["workflowId"] = workflowId;
      if (currentState) payload["currentState"] = currentState;
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

  const typeName = entityType?.plural
    ? singularize(entityType.plural)
    : (entityType?.name ?? "Record");

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

        <div
          style={{
            display: "flex",
            gap: "4px",
            borderBottom: "1px solid var(--border-color)",
            marginTop: workflows.length > 0 ? "8px" : "0",
            marginBottom: "16px",
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab("mandate")}
            className={
              activeTab === "mandate" ? "tab-button active" : "tab-button"
            }
            style={{
              padding: "8px 14px",
              border: "none",
              background: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "13px",
              borderBottom:
                activeTab === "mandate"
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
              color:
                activeTab === "mandate"
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
            }}
          >
            Mandate
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("other")}
            className={
              activeTab === "other" ? "tab-button active" : "tab-button"
            }
            style={{
              padding: "8px 14px",
              border: "none",
              background: "none",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "13px",
              borderBottom:
                activeTab === "other"
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
              color:
                activeTab === "other"
                  ? "var(--text-primary)"
                  : "var(--text-muted)",
            }}
          >
            Other
          </button>
        </div>

        {activeTab === "mandate" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
            }}
          >
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label className="form-label">
                Assign To<span style={{ color: "var(--danger)" }}> *</span>
              </label>
              <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
                <button
                  type="button"
                  onClick={() => setAssignMode("user")}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    borderRadius: "var(--radius-sm)",
                    border: "1.5px solid var(--border-color)",
                    cursor: "pointer",
                    background:
                      assignMode === "user"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      assignMode === "user" ? "#fff" : "var(--text-primary)",
                  }}
                >
                  User
                </button>
                <button
                  type="button"
                  onClick={() => setAssignMode("team")}
                  style={{
                    padding: "5px 12px",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    borderRadius: "var(--radius-sm)",
                    border: "1.5px solid var(--border-color)",
                    cursor: "pointer",
                    background:
                      assignMode === "team"
                        ? "var(--accent-primary)"
                        : "var(--bg-primary)",
                    color:
                      assignMode === "team" ? "#fff" : "var(--text-primary)",
                  }}
                >
                  Team
                </button>
              </div>
              {assignMode === "user" ? (
                <UserPicker
                  users={users}
                  value={assignedTo}
                  onChange={setAssignedTo}
                />
              ) : (
                <select
                  className="form-input"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">Select a team…</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="form-group">
              <label className="form-label">
                Due Date<span style={{ color: "var(--danger)" }}> *</span>
              </label>
              <input
                type="datetime-local"
                className="form-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                Severity<span style={{ color: "var(--danger)" }}> *</span>
              </label>
              <SeverityDropdown value={severity} onChange={setSeverity} />
            </div>
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label className="form-label">
                Remark<span style={{ color: "var(--danger)" }}> *</span>
              </label>
              <textarea
                className="form-input"
                rows={3}
                maxLength={4000}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>
            {mandateFields.map((f) => (
              <div
                key={f.id}
                style={
                  f.fieldType === "longtext" ? { gridColumn: "1 / -1" } : {}
                }
                className="form-group"
              >
                <label className="form-label">
                  {f.label}
                  <span style={{ color: "var(--danger)" }}> *</span>
                </label>
                <FieldInput
                  field={f}
                  value={fieldValues[f.name]}
                  required
                  moduleSlug={moduleSlug}
                  entityId={undefined}
                  onChange={(v) =>
                    setFieldValues((p) => ({ ...p, [f.name]: v }))
                  }
                />
              </div>
            ))}
          </div>
        )}

        {activeTab === "other" && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "16px",
            }}
          >
            {otherFields.map((f) => (
              <div
                key={f.id}
                style={
                  f.fieldType === "longtext" ? { gridColumn: "1 / -1" } : {}
                }
                className="form-group"
              >
                <label className="form-label">{f.label}</label>
                <FieldInput
                  field={f}
                  value={fieldValues[f.name]}
                  required={false}
                  moduleSlug={moduleSlug}
                  entityId={undefined}
                  onChange={(v) =>
                    setFieldValues((p) => ({ ...p, [f.name]: v }))
                  }
                />
              </div>
            ))}
            {otherFields.length === 0 && (
              <p style={{ color: "var(--text-muted)", margin: "8px 0" }}>
                No other fields defined for this entity type.
              </p>
            )}
          </div>
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
            {saving ? "Creating…" : "Create Ticket"}
          </Button>
        </div>
      </form>
    </div>
  );
}
