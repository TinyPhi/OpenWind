import React from "react";
import { UserRefPicker } from "./user-ref-picker.js";
import { EntityRefPicker } from "./entity-ref-picker.js";
import { FileFieldPicker } from "./file-field-picker.js";

/**
 * Consolidated field input dispatcher (#197), replacing four near-identical
 * copies in record-detail.tsx, record-create.tsx, instance-detail.tsx and
 * instance-create.tsx. `classPrefix` reproduces each page's original CSS
 * scope ("portal-*" for customer pages, "form-*" for entity-types pages) so
 * existing stylesheets keep applying unchanged.
 */

export type FieldInputClassPrefix = "portal" | "form";

export interface FieldInputField {
  id: string;
  name: string;
  label: string;
  fieldType: string;
  isSystem: boolean;
  isRequired: boolean;
  config: {
    options?: Array<string | { label: string; value: string; color?: string }>;
    allowedCurrencies?: string[];
    target_entity_type?: string;
  };
}

export interface FieldInputProps {
  field: FieldInputField;
  value: unknown;
  onChange: (v: unknown) => void;
  classPrefix?: FieldInputClassPrefix;
  /** Set `required` on the underlying control. Omit on read-only/detail views. */
  required?: boolean;
  /** Required for `file`/`files` fields — the upload API's namespacing param. */
  moduleSlug: string;
  /** Entity the field belongs to. Undefined during create flows. */
  entityId: string | undefined;
}

function formatReadOnlyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function FieldInput({
  field,
  value,
  onChange,
  classPrefix = "form",
  required,
  moduleSlug,
  entityId,
}: FieldInputProps): React.ReactElement {
  const strVal = value === null || value === undefined ? "" : String(value);
  const req = required ?? false;

  switch (field.fieldType) {
    case "file":
    case "files":
      return (
        <FileFieldPicker
          value={value as string | string[] | null}
          onChange={onChange}
          multiple={field.fieldType === "files"}
          moduleSlug={moduleSlug}
          entityId={entityId}
        />
      );

    case "formula":
    case "lookup":
      return (
        <input
          className={`${classPrefix}-input`}
          type="text"
          value={formatReadOnlyValue(value)}
          disabled
          readOnly
        />
      );

    case "user_ref":
      return (
        <UserRefPicker
          value={typeof value === "string" ? value : null}
          onChange={onChange}
        />
      );

    case "entity_ref":
      return (
        <EntityRefPicker
          targetEntityTypeName={field.config.target_entity_type ?? ""}
          value={typeof value === "string" ? value : null}
          onChange={onChange}
          classPrefix={classPrefix}
        />
      );

    case "boolean":
      return (
        <label
          className={classPrefix === "portal" ? "portal-checkbox" : undefined}
          style={
            classPrefix === "portal"
              ? undefined
              : {
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                }
          }
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
      return (
        <input
          className={`${classPrefix}-input`}
          type="number"
          value={strVal}
          required={req}
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
            className={`${classPrefix}-input`}
            type="number"
            placeholder="0.00"
            value={amountStr}
            required={req}
            style={{ flex: 1 }}
            onChange={(e) =>
              onChange({
                amount: e.target.value === "" ? null : Number(e.target.value),
                currency: currencyStr || currencies[0],
              })
            }
          />
          <select
            className={`${classPrefix}-input`}
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
          className={`${classPrefix}-input`}
          type="date"
          value={strVal}
          required={req}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );

    case "datetime":
      return (
        <input
          className={`${classPrefix}-input`}
          type="datetime-local"
          value={strVal}
          required={req}
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
          className={`${classPrefix}-input`}
          value={strVal}
          required={req}
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
          className={
            classPrefix === "portal"
              ? "portal-input portal-textarea"
              : "form-input"
          }
          value={strVal}
          required={req}
          rows={4}
          style={classPrefix === "form" ? { resize: "vertical" } : undefined}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );

    default:
      return (
        <input
          className={`${classPrefix}-input`}
          type="text"
          value={strVal}
          required={req}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}
