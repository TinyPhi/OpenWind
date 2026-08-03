import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../../lib/api.js";
import { EMPTY_WIZARD, genId } from "./types.js";
import type { WizardData, ActionItem, ConditionGroup } from "./types.js";
import { ensureIds } from "./step-conditions.js";
import { StepTrigger } from "./step-trigger.js";
import { StepConditions } from "./step-conditions.js";
import { StepActions } from "./step-actions.js";
import { StepSave } from "./step-save.js";

const STEPS = [
  { label: "Trigger", key: "trigger" },
  { label: "Conditions", key: "conditions" },
  { label: "Actions", key: "actions" },
  { label: "Save", key: "save" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export function canAdvance(step: StepKey, data: WizardData): boolean {
  if (step === "trigger") return data.triggerType !== "";
  if (step === "actions") return data.actions.length > 0;
  if (step === "save") return data.name.trim() !== "";
  return true;
}

function stepIndex(key: StepKey): number {
  return STEPS.findIndex((s) => s.key === key);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function AutomationWizard(): React.ReactElement {
  const navigate = useNavigate();
  const { id: rawId } = useParams<{ id: string }>();
  // Validate the URL param before using it in fetch URLs — rawId is user-controlled
  const id = rawId && UUID_RE.test(rawId) ? rawId : undefined;
  const isEdit = Boolean(id);

  const [step, setStep] = useState<StepKey>("trigger");
  const [data, setData] = useState<WizardData>(EMPTY_WIZARD);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load existing rule when editing
  useEffect(() => {
    if (!isEdit || !id) return;
    fetchWithAuth(`${API_URL}/automation-rules/${id}`)
      .then((res) => {
        const rule = (res as { data: Record<string, unknown> }).data;
        // Server returns untyped Record — Zod schema is dynamic so TypeScript cannot narrow these
        setData({
          triggerType:
            (rule.triggerType as WizardData["triggerType"] | undefined) ?? "",
          triggerConfig:
            (rule.triggerConfig as Record<string, unknown> | undefined) ?? {},
          // Assign stable ids to nodes loaded from server — server stores the tree without ids
          conditions: rule.conditions
            ? (ensureIds(rule.conditions as ConditionGroup) as ConditionGroup)
            : null,
          // Server strips the local `id` field — assign fresh IDs so React keys are stable
          actions: (
            (rule.actions as Array<Omit<ActionItem, "id">> | undefined) ?? []
          ).map((a) => ({ ...a, id: genId() })),
          name: (rule.name as string | undefined) ?? "",
          priority: (rule.priority as number | undefined) ?? 0,
          isEnabled: (rule.isEnabled as boolean | undefined) ?? true,
        });
      })
      .catch(() => {
        setSaveError("Failed to load rule");
      })
      .finally(() => setLoading(false));
  }, [id, isEdit]);

  function patch(p: Partial<WizardData>): void {
    setData((prev) => ({ ...prev, ...p }));
  }

  function goNext(): void {
    const idx = stepIndex(step);
    const next = STEPS[idx + 1];
    if (next) setStep(next.key);
  }

  function goBack(): void {
    const idx = stepIndex(step);
    const prev = STEPS[idx - 1];
    if (prev) setStep(prev.key);
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        name: data.name.trim(),
        triggerType: data.triggerType,
        triggerConfig: data.triggerConfig,
        conditions: data.conditions,
        actions: data.actions.map(({ id: _id, ...rest }) => rest),
        priority: data.priority,
        isEnabled: data.isEnabled,
      };

      if (isEdit && id) {
        await fetchWithAuth(`${API_URL}/automation-rules/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await fetchWithAuth(`${API_URL}/automation-rules`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }

      void navigate("/automations");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  }

  const currentIndex = stepIndex(step);
  const isLast = currentIndex === STEPS.length - 1;
  const advanceOk = canAdvance(step, data);

  if (loading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <p className="loader-text">Loading rule…</p>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "32px 36px",
        maxWidth: "760px",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: "28px" }}>
        <h2 className="page-title">
          {isEdit ? "Edit Automation Rule" : "New Automation Rule"}
        </h2>
        <p className="page-subtitle">
          {isEdit
            ? "Update the trigger, conditions, and actions for this rule."
            : "Configure when and how this rule fires."}
        </p>
      </div>

      {/* Step indicator */}
      <div
        style={{
          display: "flex",
          gap: "0",
          marginBottom: "32px",
          position: "relative",
        }}
      >
        {STEPS.map((s, i) => {
          const done = i < currentIndex;
          const active = s.key === step;
          return (
            <div
              key={s.key}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "6px",
                position: "relative",
              }}
            >
              {/* Connector line */}
              {i < STEPS.length - 1 && (
                <div
                  style={{
                    position: "absolute",
                    top: "14px",
                    left: "calc(50% + 14px)",
                    right: "calc(-50% + 14px)",
                    height: "2px",
                    background: done
                      ? "var(--accent-primary)"
                      : "var(--border-color)",
                    transition: "background 0.2s",
                  }}
                />
              )}
              {/* Circle */}
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "12px",
                  fontWeight: 700,
                  background: active
                    ? "var(--accent-primary)"
                    : done
                      ? "var(--accent-primary)"
                      : "var(--bg-secondary)",
                  color: active || done ? "#fff" : "var(--text-muted)",
                  border: `2px solid ${active || done ? "var(--accent-primary)" : "var(--border-color)"}`,
                  transition: "all 0.2s",
                  position: "relative",
                  zIndex: 1,
                }}
              >
                {done ? "✓" : i + 1}
              </div>
              {/* Label */}
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: active ? 700 : 500,
                  color: active
                    ? "var(--accent-primary)"
                    : done
                      ? "var(--text-secondary)"
                      : "var(--text-muted)",
                }}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div
        style={{
          border: "1px solid var(--border-color)",
          borderRadius: "12px",
          padding: "24px",
          background: "var(--bg-card)",
          marginBottom: "24px",
        }}
      >
        <h3
          style={{
            margin: "0 0 20px",
            fontSize: "15px",
            fontWeight: 700,
          }}
        >
          {STEPS[currentIndex]?.label}
        </h3>

        {step === "trigger" && <StepTrigger data={data} onChange={patch} />}
        {step === "conditions" && (
          <StepConditions data={data} onChange={patch} />
        )}
        {step === "actions" && <StepActions data={data} onChange={patch} />}
        {step === "save" && (
          <StepSave
            data={data}
            onChange={patch}
            saving={saving}
            error={saveError}
          />
        )}
      </div>

      {/* Navigation */}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Button
          variant="secondary"
          onClick={
            currentIndex === 0 ? () => void navigate("/automations") : goBack
          }
          disabled={saving}
        >
          {currentIndex === 0 ? "Cancel" : "← Back"}
        </Button>

        {isLast ? (
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving || !advanceOk}
            style={{ minWidth: "120px" }}
          >
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create rule"}
          </Button>
        ) : (
          <Button variant="primary" onClick={goNext} disabled={!advanceOk}>
            Next →
          </Button>
        )}
      </div>
    </div>
  );
}
