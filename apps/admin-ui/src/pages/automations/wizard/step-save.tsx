import React from "react";
import { useTranslation } from "react-i18next";
import type { WizardData, ConditionNode } from "./types.js";

type Props = {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
  saving: boolean;
  error: string | null;
};

export function StepSave({
  data,
  onChange,
  saving,
  error,
}: Props): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <p
        style={{ color: "var(--text-secondary)", fontSize: "13px", margin: 0 }}
      >
        {t("automations.saveHelp", {
          defaultValue:
            "Give this rule a name, set its priority, and choose whether it starts enabled.",
        })}
      </p>

      <div className="form-group">
        <label className="form-label" htmlFor="rule-name">
          {t("automations.ruleNameLabel", { defaultValue: "Rule name" })}{" "}
          <span style={{ color: "var(--danger)" }}>*</span>
        </label>
        <input
          id="rule-name"
          className="form-input"
          placeholder={t("automations.ruleNamePlaceholder", {
            defaultValue: "e.g. Notify assignee on SLA breach",
          })}
          value={data.name}
          onChange={(e) => onChange({ name: e.target.value })}
          disabled={saving}
          autoFocus
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="rule-priority">
          {t("automations.priority", { defaultValue: "Priority" })}
        </label>
        <input
          id="rule-priority"
          className="form-input"
          type="number"
          min={0}
          max={999}
          style={{ width: "120px" }}
          value={data.priority}
          onChange={(e) =>
            onChange({
              priority: Math.max(0, parseInt(e.target.value, 10) || 0),
            })
          }
          disabled={saving}
        />
        <p
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            marginTop: "4px",
          }}
        >
          {t("automations.priorityHelp", {
            defaultValue:
              "Lower numbers run first when multiple rules fire on the same event.",
          })}
        </p>
      </div>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          cursor: saving ? "not-allowed" : "pointer",
          fontSize: "13px",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: "36px",
            height: "20px",
            borderRadius: "10px",
            background: data.isEnabled
              ? "var(--success)"
              : "var(--border-color)",
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}
          onClick={() => !saving && onChange({ isEnabled: !data.isEnabled })}
        >
          <span
            style={{
              display: "block",
              width: "14px",
              height: "14px",
              borderRadius: "50%",
              background: "#fff",
              position: "absolute",
              top: "3px",
              left: data.isEnabled ? "19px" : "3px",
              transition: "left 0.2s",
            }}
          />
        </span>
        <span style={{ fontWeight: 600 }}>
          {data.isEnabled
            ? t("automations.enabled", { defaultValue: "Enabled" })
            : t("automations.disabled", { defaultValue: "Disabled" })}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>
          {data.isEnabled
            ? t("automations.enabledHelp", {
                defaultValue: "Rule will fire immediately after saving.",
              })
            : t("automations.disabledHelp", {
                defaultValue: "Rule is saved but will not fire until enabled.",
              })}
        </span>
      </label>

      {/* Summary */}
      <div
        style={{
          border: "1px solid var(--border-color)",
          borderRadius: "10px",
          padding: "16px",
          background: "var(--bg-secondary)",
          fontSize: "12px",
          color: "var(--text-secondary)",
          lineHeight: 1.6,
        }}
      >
        <p
          style={{
            margin: "0 0 6px",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {t("automations.summary", { defaultValue: "Summary" })}
        </p>
        <p style={{ margin: "0 0 4px" }}>
          <strong>
            {t("automations.summaryTrigger", { defaultValue: "Trigger:" })}
          </strong>{" "}
          {data.triggerType || (
            <em style={{ color: "var(--danger)" }}>
              {t("automations.notSet", { defaultValue: "not set" })}
            </em>
          )}
        </p>
        <p style={{ margin: "0 0 4px" }}>
          <strong>
            {t("automations.summaryConditions", {
              defaultValue: "Conditions:",
            })}
          </strong>{" "}
          {data.conditions
            ? t("automations.conditionsCount", {
                count: countLeaves(data.conditions),
                defaultValue: `${countLeaves(data.conditions)} condition(s)`,
              })
            : t("automations.noneAlwaysFires", {
                defaultValue: "none (always fires)",
              })}
        </p>
        <p style={{ margin: 0 }}>
          <strong>
            {t("automations.summaryActions", { defaultValue: "Actions:" })}
          </strong>{" "}
          {data.actions.length === 0 ? (
            <em style={{ color: "var(--danger)" }}>
              {t("automations.atLeastOneRequired", {
                defaultValue: "at least 1 required",
              })}
            </em>
          ) : (
            t("automations.actionsCount", {
              count: data.actions.length,
              defaultValue: `${data.actions.length} action(s)`,
            })
          )}
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
    </div>
  );
}

function countLeaves(node: ConditionNode): number {
  if ("children" in node) {
    return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
  }
  return 1;
}
