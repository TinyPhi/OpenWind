import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DIALOG_CONTENT_RESET,
} from "@platform/ui";

/**
 * Shared workflow-transition modal (#198), consolidating two byte-for-byte
 * identical copies (same component body, same .tm-* classNames, same scoped
 * CSS) that had been copy-pasted into workflow-records.tsx and
 * record-list.tsx rather than shared. Keeps the original .tm-* class names
 * and field-rendering logic as-is (only the outer backdrop/card wrapper
 * changes, from a bespoke div pair to Dialog/DialogContent) so neither
 * file's scoped <style jsx> block needs touching.
 */

type FieldConfigOption =
  | string
  | { label: string; value: string; color?: string };

export interface TransitionModalField {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  config: { options?: FieldConfigOption[] };
}

export interface TransitionModalRecord {
  fields: Record<string, unknown>;
}

export interface TransitionModalTransition {
  requiresComment: boolean;
  requiresFields: string[];
}

export interface TransitionModalProps {
  open: boolean;
  record: TransitionModalRecord;
  transition: TransitionModalTransition;
  toStateLabel: string;
  allFields: TransitionModalField[];
  onConfirm: (comment: string, fieldUpdates: Record<string, unknown>) => void;
  onCancel: () => void;
}

export function TransitionModal({
  open,
  record,
  transition,
  toStateLabel,
  allFields,
  onConfirm,
  onCancel,
}: TransitionModalProps): React.ReactElement {
  const [comment, setComment] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const name of transition.requiresFields) {
      const existing = record.fields[name];
      init[name] =
        existing !== null && existing !== undefined ? String(existing) : "";
    }
    return init;
  });

  const requiredFields = transition.requiresFields
    .map((name) => allFields.find((f) => f.name === name))
    .filter(Boolean) as TransitionModalField[];

  const isValid =
    (!transition.requiresComment || comment.trim().length > 0) &&
    transition.requiresFields.every(
      (name) => (fieldValues[name] ?? "").trim().length > 0,
    );

  function handleFieldChange(name: string, value: string): void {
    setFieldValues((prev) => ({ ...prev, [name]: value }));
  }

  function handleSubmit(): void {
    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fieldValues)) {
      if (v.trim()) updates[k] = v.trim();
    }
    onConfirm(comment, updates);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="tm-modal" style={DIALOG_CONTENT_RESET}>
        <div className="tm-header">
          <div className="tm-header-left">
            <span className="tm-icon">→</span>
            <DialogTitle asChild>
              <span className="tm-title">Move to {toStateLabel}</span>
            </DialogTitle>
          </div>
          <DialogClose asChild>
            <button className="tm-close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M1 1l12 12M13 1L1 13"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </DialogClose>
        </div>

        <div className="tm-body">
          {requiredFields.map((f) => (
            <div key={f.id} className="tm-field">
              <label className="tm-label">
                {f.label}
                <span className="tm-required">*</span>
              </label>
              {f.fieldType === "enum" ? (
                <select
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                >
                  <option value="">Select…</option>
                  {(f.config.options ?? []).map((opt) => {
                    const val = typeof opt === "string" ? opt : opt.value;
                    const lbl = typeof opt === "string" ? opt : opt.label;
                    return (
                      <option key={val} value={val}>
                        {lbl}
                      </option>
                    );
                  })}
                </select>
              ) : f.fieldType === "long_text" ? (
                <textarea
                  className="tm-input tm-textarea"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                  rows={3}
                  placeholder={`Enter ${f.label.toLowerCase()}…`}
                />
              ) : f.fieldType === "number" || f.fieldType === "currency" ? (
                <input
                  type="number"
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                  placeholder={`Enter ${f.label.toLowerCase()}…`}
                />
              ) : f.fieldType === "date" || f.fieldType === "datetime" ? (
                <input
                  type={f.fieldType === "datetime" ? "datetime-local" : "date"}
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                />
              ) : (
                <input
                  type="text"
                  className="tm-input"
                  value={fieldValues[f.name] ?? ""}
                  onChange={(e) => handleFieldChange(f.name, e.target.value)}
                  placeholder={`Enter ${f.label.toLowerCase()}…`}
                />
              )}
            </div>
          ))}

          {transition.requiresComment && (
            <div className="tm-field">
              <label className="tm-label">
                Comment
                <span className="tm-required">*</span>
              </label>
              <textarea
                className="tm-input tm-textarea"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder="Add a comment for this transition…"
                autoFocus
              />
            </div>
          )}
        </div>

        <div className="tm-footer">
          <button className="tm-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="tm-btn-confirm"
            onClick={handleSubmit}
            disabled={!isValid}
          >
            Confirm
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
