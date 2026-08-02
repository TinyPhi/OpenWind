import React from "react";
import { Button, IconButton } from "@platform/ui";
import type { WizardData, ActionItem, ActionType } from "./types.js";
import { genId } from "./types.js";

type Props = {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
};

const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  notify: "Send notification",
  set_field: "Set field value",
  transition: "Trigger transition",
  webhook: "Call webhook",
};

const ACTION_TYPE_DESCRIPTIONS: Record<ActionType, string> = {
  notify: "Send an in-app or email notification to recipients",
  set_field: "Update a field on the triggering record",
  transition: "Move the record to another state",
  webhook: "HTTP POST to an external URL",
};

function NotifyConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div className="form-group">
        <label className="form-label">Recipients</label>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {(["assignee", "creator", "all_agents"] as const).map((r) => {
            const selected = (
              (config.recipients as string[] | undefined) ?? []
            ).includes(r);
            return (
              <label
                key={r}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => {
                    const current =
                      (config.recipients as string[] | undefined) ?? [];
                    const next = selected
                      ? current.filter((x) => x !== r)
                      : [...current, r];
                    onChange({ recipients: next });
                  }}
                />
                {r === "assignee"
                  ? "Assignee"
                  : r === "creator"
                    ? "Creator"
                    : "All agents"}
              </label>
            );
          })}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Channels</label>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
          {(["in_app", "email"] as const).map((ch) => {
            const selected = (
              (config.channels as string[] | undefined) ?? []
            ).includes(ch);
            return (
              <label
                key={ch}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => {
                    const current =
                      (config.channels as string[] | undefined) ?? [];
                    const next = selected
                      ? current.filter((x) => x !== ch)
                      : [...current, ch];
                    onChange({ channels: next });
                  }}
                />
                {ch === "in_app" ? "In-app" : "Email"}
              </label>
            );
          })}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Message (optional)</label>
        <textarea
          className="form-input"
          rows={2}
          style={{ resize: "vertical" }}
          placeholder="Custom notification message…"
          value={(config.message as string | undefined) ?? ""}
          onChange={(e) => onChange({ message: e.target.value })}
        />
      </div>
    </div>
  );
}

function SetFieldConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
      <div className="form-group" style={{ flex: 1, minWidth: "160px" }}>
        <label className="form-label">Field name</label>
        <input
          className="form-input"
          placeholder="field_name"
          value={(config.fieldName as string | undefined) ?? ""}
          onChange={(e) => onChange({ fieldName: e.target.value })}
        />
      </div>
      <div className="form-group" style={{ flex: 2, minWidth: "160px" }}>
        <label className="form-label">Value</label>
        <input
          className="form-input"
          placeholder="new value"
          value={(config.value as string | undefined) ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
        />
      </div>
    </div>
  );
}

function TransitionConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="form-group">
      <label className="form-label">Transition name</label>
      <input
        className="form-input"
        placeholder="e.g. auto_approve"
        value={(config.transitionName as string | undefined) ?? ""}
        onChange={(e) => onChange({ transitionName: e.target.value })}
      />
      <p
        style={{
          fontSize: "11px",
          color: "var(--text-muted)",
          marginTop: "4px",
        }}
      >
        The name of the transition to execute on the triggering record.
      </p>
    </div>
  );
}

function WebhookConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  const headers =
    (config.headers as Array<{ key: string; value: string }> | undefined) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div className="form-group" style={{ flex: 1, minWidth: "200px" }}>
          <label className="form-label">URL (https://)</label>
          <input
            className="form-input"
            type="url"
            placeholder="https://example.com/webhook"
            value={(config.url as string | undefined) ?? ""}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        </div>
        <div className="form-group" style={{ minWidth: "100px" }}>
          <label className="form-label">Method</label>
          <select
            className="form-input"
            value={(config.method as string | undefined) ?? "POST"}
            onChange={(e) => onChange({ method: e.target.value })}
          >
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
          </select>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Headers</label>
        {headers.map((h, i) => (
          <div
            key={i}
            style={{ display: "flex", gap: "8px", marginBottom: "6px" }}
          >
            <input
              className="form-input"
              style={{ flex: 1 }}
              placeholder="Key"
              value={h.key}
              onChange={(e) => {
                const next = headers.map((x, j) =>
                  j === i ? { ...x, key: e.target.value } : x,
                );
                onChange({ headers: next });
              }}
            />
            <input
              className="form-input"
              style={{ flex: 2 }}
              placeholder="Value"
              value={h.value}
              onChange={(e) => {
                const next = headers.map((x, j) =>
                  j === i ? { ...x, value: e.target.value } : x,
                );
                onChange({ headers: next });
              }}
            />
            <IconButton
              variant="delete"
              onClick={() =>
                onChange({ headers: headers.filter((_, j) => j !== i) })
              }
              title="Remove header"
              aria-label="Remove header"
            >
              ×
            </IconButton>
          </div>
        ))}
        <Button
          variant="secondary"
          style={{ fontSize: "11px", padding: "4px 10px", marginTop: "4px" }}
          onClick={() =>
            onChange({ headers: [...headers, { key: "", value: "" }] })
          }
        >
          + Add header
        </Button>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          fontSize: "13px",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={(config.includePayload as boolean | undefined) ?? true}
          onChange={(e) => onChange({ includePayload: e.target.checked })}
        />
        Include record payload in request body
      </label>

      <p
        style={{
          fontSize: "11px",
          color: "var(--text-muted)",
          marginTop: "6px",
          padding: "8px 10px",
          background: "var(--bg-secondary)",
          borderRadius: "6px",
          lineHeight: 1.5,
        }}
      >
        <strong>Note:</strong> The automation engine validates webhook URLs
        server-side before each call (DNS resolution + private IP blocklist).
        Calls to private/internal addresses are blocked automatically.
      </p>
    </div>
  );
}

function ActionCard({
  action,
  index,
  onUpdate,
  onRemove,
}: {
  action: ActionItem;
  index: number;
  onUpdate: (id: string, patch: Partial<ActionItem>) => void;
  onRemove: (id: string) => void;
}): React.ReactElement {
  function patchConfig(patch: Record<string, unknown>): void {
    onUpdate(action.id, { config: { ...action.config, ...patch } });
  }

  return (
    <div
      style={{
        border: "1px solid var(--border-color)",
        borderRadius: "10px",
        padding: "16px",
        marginBottom: "12px",
        background: "var(--bg-card)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "var(--text-muted)",
              background: "var(--bg-secondary)",
              borderRadius: "6px",
              padding: "2px 8px",
            }}
          >
            #{index + 1}
          </span>
          <select
            className="form-input"
            style={{ width: "200px", fontWeight: 600 }}
            value={action.type}
            onChange={(e) =>
              onUpdate(action.id, {
                // select options are derived from ActionType keys — value is always a valid ActionType
                type: e.target.value as ActionType,
                config: {},
              })
            }
          >
            {(Object.keys(ACTION_TYPE_LABELS) as ActionType[]).map((t) => (
              <option key={t} value={t}>
                {ACTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {ACTION_TYPE_DESCRIPTIONS[action.type]}
          </span>
        </div>
        <IconButton
          variant="delete"
          onClick={() => onRemove(action.id)}
          title="Remove action"
          aria-label="Remove action"
        >
          🗑
        </IconButton>
      </div>

      {action.type === "notify" && (
        <NotifyConfig config={action.config} onChange={patchConfig} />
      )}
      {action.type === "set_field" && (
        <SetFieldConfig config={action.config} onChange={patchConfig} />
      )}
      {action.type === "transition" && (
        <TransitionConfig config={action.config} onChange={patchConfig} />
      )}
      {action.type === "webhook" && (
        <WebhookConfig config={action.config} onChange={patchConfig} />
      )}
    </div>
  );
}

export function StepActions({ data, onChange }: Props): React.ReactElement {
  function addAction(): void {
    onChange({
      actions: [...data.actions, { id: genId(), type: "notify", config: {} }],
    });
  }

  function updateAction(id: string, patch: Partial<ActionItem>): void {
    onChange({
      actions: data.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    });
  }

  function removeAction(id: string): void {
    onChange({ actions: data.actions.filter((a) => a.id !== id) });
  }

  return (
    <div>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "13px",
          marginBottom: "16px",
        }}
      >
        Define what happens when this rule fires. At least one action is
        required.
      </p>

      {data.actions.length === 0 && (
        <div
          style={{
            border: "2px dashed var(--border-color)",
            borderRadius: "10px",
            padding: "24px",
            textAlign: "center",
            marginBottom: "12px",
          }}
        >
          <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>
            No actions yet — add at least one.
          </p>
        </div>
      )}

      {data.actions.map((action, i) => (
        <ActionCard
          key={action.id}
          action={action}
          index={i}
          onUpdate={updateAction}
          onRemove={removeAction}
        />
      ))}

      <Button variant="secondary" onClick={addAction}>
        + Add Action
      </Button>
    </div>
  );
}
