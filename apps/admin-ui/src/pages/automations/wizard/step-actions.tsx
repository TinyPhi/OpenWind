import React from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { Button, IconButton } from "@platform/ui";
import type { WizardData, ActionItem, ActionType } from "./types.js";
import { genId } from "./types.js";
import {
  restrictionReason,
  transitionActionProblem,
  transitionOptionLabel,
} from "./transition-action.js";
import type { TransitionsState } from "./transition-action.js";
import { TicketTemplateConfig } from "./step-ticket-template.js";
import { defaultTemplate, isTicketAction } from "./ticket-template.js";

type Props = {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
  transitions: TransitionsState;
};

export const ALL_ACTION_TYPES: ActionType[] = [
  "notify",
  "set_field",
  "transition",
  "webhook",
  "create_entity",
  "create_child",
];

const getActionTypeLabels = (): Record<ActionType, string> => ({
  notify: i18next.t("automations.actionLabelNotify", {
    defaultValue: "Send notification",
  }),
  set_field: i18next.t("automations.actionLabelSetField", {
    defaultValue: "Set field value",
  }),
  transition: i18next.t("automations.actionLabelTransition", {
    defaultValue: "Trigger transition",
  }),
  webhook: i18next.t("automations.actionLabelWebhook", {
    defaultValue: "Call webhook",
  }),
  create_entity: i18next.t("automations.actionLabelCreateTicket", {
    defaultValue: "Create ticket",
  }),
  create_child: i18next.t("automations.actionLabelCreateSubTask", {
    defaultValue: "Create sub-task",
  }),
});

const getActionTypeDescriptions = (): Record<ActionType, string> => ({
  notify: i18next.t("automations.actionDescNotify", {
    defaultValue: "Send an in-app or email notification to recipients",
  }),
  set_field: i18next.t("automations.actionDescSetField", {
    defaultValue: "Update a field on the triggering record",
  }),
  transition: i18next.t("automations.actionDescTransition", {
    defaultValue: "Move the record to another state",
  }),
  webhook: i18next.t("automations.actionDescWebhook", {
    defaultValue: "HTTP POST to an external URL",
  }),
  create_entity: i18next.t("automations.actionDescCreateTicket", {
    defaultValue: "Create a ticket in a workflow",
  }),
  create_child: i18next.t("automations.actionDescCreateSubTask", {
    defaultValue: "Create a sub-task under the triggering ticket",
  }),
});

function NotifyConfig({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div className="form-group">
        <label className="form-label">
          {t("automations.recipients", { defaultValue: "Recipients" })}
        </label>
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
                  ? t("automations.recipientAssignee", {
                      defaultValue: "Assignee",
                    })
                  : r === "creator"
                    ? t("automations.recipientCreator", {
                        defaultValue: "Creator",
                      })
                    : t("automations.recipientAllAgents", {
                        defaultValue: "All agents",
                      })}
              </label>
            );
          })}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">
          {t("automations.channels", { defaultValue: "Channels" })}
        </label>
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
                {ch === "in_app"
                  ? t("automations.channelInApp", { defaultValue: "In-app" })
                  : t("automations.channelEmail", { defaultValue: "Email" })}
              </label>
            );
          })}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">
          {t("automations.messageOptional", {
            defaultValue: "Message (optional)",
          })}
        </label>
        <textarea
          className="form-input"
          rows={2}
          style={{ resize: "vertical" }}
          placeholder={t("automations.messagePlaceholder", {
            defaultValue: "Custom notification message…",
          })}
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
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
      <div className="form-group" style={{ flex: 1, minWidth: "160px" }}>
        <label className="form-label">
          {t("automations.fieldName", { defaultValue: "Field name" })}
        </label>
        <input
          className="form-input"
          placeholder={t("automations.fieldNamePlaceholder", {
            defaultValue: "field_name",
          })}
          value={(config.field as string | undefined) ?? ""}
          onChange={(e) => onChange({ field: e.target.value })}
        />
      </div>
      <div className="form-group" style={{ flex: 2, minWidth: "160px" }}>
        <label className="form-label">
          {t("automations.value", { defaultValue: "Value" })}
        </label>
        <input
          className="form-input"
          placeholder={t("automations.valuePlaceholder", {
            defaultValue: "new value",
          })}
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
  transitions,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
  transitions: TransitionsState;
}): React.ReactElement {
  const { t } = useTranslation();
  const problem = transitionActionProblem(config, transitions);
  const options = transitions.status === "ready" ? transitions.transitions : [];
  const transitionId =
    typeof config.transitionId === "string" ? config.transitionId : "";
  const selected = options.find((tr) => tr.id === transitionId);
  const comment = typeof config.comment === "string" ? config.comment : "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {transitions.status === "ready" && (
        <div className="form-group">
          <label className="form-label" htmlFor="transition-action-select">
            {t("automations.transition", { defaultValue: "Transition" })}
          </label>
          <select
            id="transition-action-select"
            className="form-input"
            value={selected ? transitionId : ""}
            onChange={(e) => onChange({ transitionId: e.target.value })}
          >
            <option value="">
              {options.length === 0
                ? t("automations.noTransitionsInWorkflow", {
                    defaultValue: "This workflow has no transitions",
                  })
                : t("automations.selectTransition", {
                    defaultValue: "Select a transition…",
                  })}
            </option>
            {options.map((tr) => {
              const restricted = restrictionReason(tr);
              return (
                <option
                  key={tr.id}
                  value={tr.id}
                  disabled={restricted !== null}
                >
                  {transitionOptionLabel(tr)}
                  {restricted ? ` — ${restricted}` : ""}
                </option>
              );
            })}
          </select>
        </div>
      )}
      {selected?.requiresComment && (
        <div className="form-group">
          <label className="form-label" htmlFor="transition-action-comment">
            {t("automations.commentRequired", {
              defaultValue: "Comment (required by this transition)",
            })}
          </label>
          <input
            id="transition-action-comment"
            className="form-input"
            value={comment}
            onChange={(e) => onChange({ comment: e.target.value })}
          />
        </div>
      )}
      {problem && (
        <p
          role="status"
          style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}
        >
          {problem}
        </p>
      )}
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
  const { t } = useTranslation();
  const headers =
    (config.headers as Array<{ key: string; value: string }> | undefined) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <div className="form-group" style={{ flex: 1, minWidth: "200px" }}>
          <label className="form-label">
            {t("automations.webhookUrl", { defaultValue: "URL (https://)" })}
          </label>
          <input
            className="form-input"
            type="url"
            placeholder="https://example.com/webhook"
            value={(config.url as string | undefined) ?? ""}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        </div>
        <div className="form-group" style={{ minWidth: "100px" }}>
          <label className="form-label">
            {t("automations.webhookMethod", { defaultValue: "Method" })}
          </label>
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
        <label className="form-label">
          {t("automations.webhookHeaders", { defaultValue: "Headers" })}
        </label>
        {headers.map((h, i) => (
          <div
            key={i}
            style={{ display: "flex", gap: "8px", marginBottom: "6px" }}
          >
            <input
              className="form-input"
              style={{ flex: 1 }}
              placeholder={t("automations.headerKey", { defaultValue: "Key" })}
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
              placeholder={t("automations.headerValue", {
                defaultValue: "Value",
              })}
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
              title={t("automations.removeHeader", {
                defaultValue: "Remove header",
              })}
              aria-label={t("automations.removeHeader", {
                defaultValue: "Remove header",
              })}
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
          + {t("automations.addHeader", { defaultValue: "Add header" })}
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
        {t("automations.includeRecordPayload", {
          defaultValue: "Include record payload in request body",
        })}
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
        <strong>
          {t("automations.notePrefix", { defaultValue: "Note:" })}
        </strong>{" "}
        {t("automations.webhookValidationNote", {
          defaultValue:
            "The automation engine validates webhook URLs server-side before each call (DNS resolution + private IP blocklist). Calls to private/internal addresses are blocked automatically.",
        })}
      </p>
    </div>
  );
}

function ActionCard({
  action,
  index,
  onUpdate,
  onRemove,
  transitions,
}: {
  action: ActionItem;
  index: number;
  onUpdate: (id: string, patch: Partial<ActionItem>) => void;
  onRemove: (id: string) => void;
  transitions: TransitionsState;
}): React.ReactElement {
  const { t } = useTranslation();
  const actionLabels = getActionTypeLabels();
  const actionDescriptions = getActionTypeDescriptions();

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
            onChange={(e) => {
              // select options are derived from ActionType keys — value is always a valid ActionType
              const type = e.target.value as ActionType;
              onUpdate(action.id, {
                type,
                config: isTicketAction(type)
                  ? { template: defaultTemplate() }
                  : {},
              });
            }}
          >
            {ALL_ACTION_TYPES.map((actionType) => (
              <option key={actionType} value={actionType}>
                {actionLabels[actionType]}
              </option>
            ))}
          </select>
          <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
            {actionDescriptions[action.type]}
          </span>
        </div>
        <IconButton
          variant="delete"
          onClick={() => onRemove(action.id)}
          title={t("automations.removeAction", {
            defaultValue: "Remove action",
          })}
          aria-label={t("automations.removeAction", {
            defaultValue: "Remove action",
          })}
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
        <TransitionConfig
          config={action.config}
          onChange={patchConfig}
          transitions={transitions}
        />
      )}
      {action.type === "webhook" && (
        <WebhookConfig config={action.config} onChange={patchConfig} />
      )}
      {(action.type === "create_entity" || action.type === "create_child") && (
        <TicketTemplateConfig
          type={action.type}
          config={action.config}
          onChange={patchConfig}
        />
      )}
    </div>
  );
}

export function StepActions({
  data,
  onChange,
  transitions,
}: Props): React.ReactElement {
  const { t } = useTranslation();

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
        {t("automations.defineActionsHelp", {
          defaultValue:
            "Define what happens when this rule fires. At least one action is required.",
        })}
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
            {t("automations.noActionsYet", {
              defaultValue: "No actions yet — add at least one.",
            })}
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
          transitions={transitions}
        />
      ))}

      <Button variant="secondary" onClick={addAction}>
        + {t("automations.addAction", { defaultValue: "Add Action" })}
      </Button>
    </div>
  );
}
