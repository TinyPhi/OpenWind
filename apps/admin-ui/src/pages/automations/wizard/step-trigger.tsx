import React, { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../../../lib/api.js";
import type { TriggerType, WizardData } from "./types.js";
import { stateKeyFor, withConfigValues } from "./payload.js";

type Props = {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
};

type WorkflowOption = {
  id: string;
  name: string;
  states: Array<{ name: string; label: string }>;
};
type EntityTypeOption = { id: string; name: string; plural: string };
type FieldOption = { id: string; name: string; label: string };

const TRIGGER_OPTIONS: Array<{
  type: TriggerType;
  label: string;
  description: string;
}> = [
  {
    type: "workflow.entered_state",
    label: "State entered",
    description: "When a record enters a specific workflow state",
  },
  {
    type: "workflow.transitioned",
    label: "Transition taken",
    description: "When a record moves between states via a named transition",
  },
  {
    type: "workflow.sla_breached",
    label: "SLA breached",
    description: "When a record exceeds the SLA time limit for a state",
  },
  {
    type: "field.changed",
    label: "Field changed",
    description: "When a specific field value is updated on a record",
  },
  {
    type: "entity.created",
    label: "Record created",
    description: "When a new record of a given type is created",
  },
  {
    type: "entity.assigned",
    label: "Record assigned",
    description: "When a record is assigned to a user",
  },
];

export function StepTrigger({ data, onChange }: Props): React.ReactElement {
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [entityTypes, setEntityTypes] = useState<EntityTypeOption[]>([]);
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [loadingEntityTypes, setLoadingEntityTypes] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = data.triggerType;

    if (
      t === "workflow.entered_state" ||
      t === "workflow.transitioned" ||
      t === "workflow.sla_breached"
    ) {
      setLoadingWorkflows(true);
      // N+1: fetches each workflow individually for states — a future /workflows?includeStates=true
      // param would collapse this into one request (requires API change, tracked separately)
      fetchWithAuth(`${API_URL}/workflows`)
        .then((res) => {
          if (cancelled) return;
          const list = (res as { data?: WorkflowOption[] }).data ?? [];
          return Promise.all(
            list.map((w) =>
              fetchWithAuth(`${API_URL}/workflows/${w.id}`).then(
                (r) => (r as { data?: WorkflowOption }).data ?? w,
              ),
            ),
          );
        })
        .then((wf) => {
          if (!cancelled && wf) setWorkflows(wf);
        })
        .catch(() => {
          if (!cancelled) setWorkflows([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingWorkflows(false);
        });
    }

    if (
      t === "field.changed" ||
      t === "entity.created" ||
      t === "entity.assigned"
    ) {
      setLoadingEntityTypes(true);
      fetchWithAuth(`${API_URL}/entity-types`)
        .then((res) => {
          if (!cancelled)
            setEntityTypes((res as { data: EntityTypeOption[] }).data);
        })
        .catch(() => {
          if (!cancelled) setEntityTypes([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingEntityTypes(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [data.triggerType]);

  // Load fields when entity type selected (for field.changed)
  const selectedEntityTypeId = data.triggerConfig.entityTypeId as
    | string
    | undefined;
  useEffect(() => {
    if (data.triggerType !== "field.changed" || !selectedEntityTypeId) return;
    let cancelled = false;
    setLoadingFields(true);
    fetchWithAuth(`${API_URL}/entity-types/${selectedEntityTypeId}/fields`)
      .then((res) => {
        if (!cancelled) setFields((res as { data: FieldOption[] }).data);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFields(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data.triggerType, selectedEntityTypeId]);

  function selectTrigger(type: TriggerType): void {
    onChange({ triggerType: type, triggerConfig: {} });
  }

  function patchConfig(patch: Record<string, unknown>): void {
    onChange({ triggerConfig: withConfigValues(data.triggerConfig, patch) });
  }

  const stateKey = stateKeyFor(data.triggerType);

  const selectedEntityType = entityTypes.find(
    (et) => et.id === selectedEntityTypeId,
  );

  const selectedWorkflow = workflows.find(
    (w) => w.id === data.triggerConfig.workflowId,
  );

  return (
    <div>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "13px",
          marginBottom: "20px",
        }}
      >
        Choose what event triggers this automation rule.
      </p>

      {/* Trigger type grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "10px",
          marginBottom: "24px",
        }}
      >
        {TRIGGER_OPTIONS.map((opt) => {
          const selected = data.triggerType === opt.type;
          return (
            <button
              key={opt.type}
              onClick={() => selectTrigger(opt.type)}
              style={{
                textAlign: "left",
                padding: "14px 16px",
                borderRadius: "10px",
                border: `2px solid ${selected ? "var(--accent-primary)" : "var(--border-color)"}`,
                background: selected
                  ? "hsla(250,84%,60%,.08)"
                  : "var(--bg-card)",
                cursor: "pointer",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  fontSize: "13px",
                  color: selected
                    ? "var(--accent-primary)"
                    : "var(--text-primary)",
                  marginBottom: "4px",
                }}
              >
                {opt.label}
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  lineHeight: 1.4,
                }}
              >
                {opt.description}
              </div>
            </button>
          );
        })}
      </div>

      {/* Conditional config fields */}
      {(data.triggerType === "workflow.entered_state" ||
        data.triggerType === "workflow.transitioned" ||
        data.triggerType === "workflow.sla_breached") && (
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <div className="form-group" style={{ flex: 1, minWidth: "200px" }}>
            <label className="form-label">Workflow</label>
            {loadingWorkflows ? (
              <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                Loading…
              </p>
            ) : (
              <select
                className="form-input"
                value={
                  (data.triggerConfig.workflowId as string | undefined) ?? ""
                }
                onChange={(e) =>
                  patchConfig({ workflowId: e.target.value, [stateKey]: "" })
                }
              >
                <option value="">— select workflow —</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {(data.triggerType === "workflow.entered_state" ||
            data.triggerType === "workflow.sla_breached") &&
            selectedWorkflow && (
              <div
                className="form-group"
                style={{ flex: 1, minWidth: "200px" }}
              >
                <label className="form-label">State</label>
                <select
                  className="form-input"
                  value={
                    (data.triggerConfig[stateKey] as string | undefined) ?? ""
                  }
                  onChange={(e) => patchConfig({ [stateKey]: e.target.value })}
                >
                  <option value="">— any state —</option>
                  {selectedWorkflow.states.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
        </div>
      )}

      {(data.triggerType === "field.changed" ||
        data.triggerType === "entity.created" ||
        data.triggerType === "entity.assigned") && (
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          <div className="form-group" style={{ flex: 1, minWidth: "200px" }}>
            <label className="form-label">Entity Type</label>
            {loadingEntityTypes ? (
              <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                Loading…
              </p>
            ) : (
              <select
                className="form-input"
                value={
                  (data.triggerConfig.entityTypeId as string | undefined) ?? ""
                }
                onChange={(e) =>
                  patchConfig({ entityTypeId: e.target.value, field: "" })
                }
              >
                <option value="">— select entity type —</option>
                {entityTypes.map((et) => (
                  <option key={et.id} value={et.id}>
                    {et.plural}
                  </option>
                ))}
              </select>
            )}
          </div>

          {data.triggerType === "field.changed" && selectedEntityTypeId && (
            <div className="form-group" style={{ flex: 1, minWidth: "200px" }}>
              <label className="form-label">Field</label>
              {loadingFields ? (
                <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  Loading…
                </p>
              ) : (
                <select
                  className="form-input"
                  value={(data.triggerConfig.field as string | undefined) ?? ""}
                  onChange={(e) => patchConfig({ field: e.target.value })}
                >
                  <option value="">— any field —</option>
                  {fields.map((f) => (
                    <option key={f.id} value={f.name}>
                      {f.label}
                    </option>
                  ))}
                </select>
              )}
              {!loadingFields && !data.triggerConfig.field && (
                <p
                  role="status"
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    marginTop: "6px",
                  }}
                >
                  This rule will fire on every update to every{" "}
                  {selectedEntityType?.name ?? "record"} record. Pick a field to
                  narrow it.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
