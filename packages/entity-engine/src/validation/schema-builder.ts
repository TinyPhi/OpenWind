import { z } from "zod";
import type { EntityField } from "../types.js";
import type { FieldError } from "../errors.js";

export function buildZodSchema(
  fields: EntityField[],
  mode: "create" | "update",
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const field of fields) {
    if (field.fieldType === "formula" || field.fieldType === "lookup") {
      // Computed fields are never written by clients
      shape[field.name] = z.never().optional();
      continue;
    }

    let fieldSchema = buildFieldSchema(field);

    if (mode === "update" || !field.isRequired) {
      fieldSchema = fieldSchema.optional();
    }

    shape[field.name] = fieldSchema;
  }

  return z.object(shape);
}

function buildFieldSchema(field: EntityField): z.ZodTypeAny {
  const cfg = field.config;

  switch (field.fieldType) {
    case "text": {
      let s = z.string();
      if (typeof cfg["minLength"] === "number") s = s.min(cfg["minLength"]);
      if (typeof cfg["maxLength"] === "number") s = s.max(cfg["maxLength"]);
      if (typeof cfg["pattern"] === "string") {
        // Defensive: pattern is validated by isSafeRegex at save time, but if
        // a malformed pattern somehow reaches here (e.g. pre-existing data) we
        // skip it silently rather than throwing during entity validation.
        try {
          s = s.regex(new RegExp(cfg["pattern"]));
        } catch {
          // Invalid regex stored in config — skip rather than crash validation
        }
      }
      return s;
    }

    case "longtext":
      return z.string();

    case "number": {
      const min = typeof cfg["min"] === "number" ? cfg["min"] : undefined;
      const max = typeof cfg["max"] === "number" ? cfg["max"] : undefined;
      const dp =
        typeof cfg["decimalPlaces"] === "number"
          ? (cfg["decimalPlaces"] as number)
          : undefined;

      let base = z.number();
      if (min !== undefined) base = base.min(min);
      if (max !== undefined) base = base.max(max);

      if (dp !== undefined) {
        return base.refine(
          (v) => (v.toString().split(".")[1] ?? "").length <= dp,
          { message: `Maximum ${dp} decimal places` },
        );
      }
      return base;
    }

    case "currency": {
      const allowed = cfg["allowedCurrencies"];
      const currencySchema =
        Array.isArray(allowed) && allowed.length > 0
          ? z.enum(allowed as [string, ...string[]])
          : z.string().length(3);
      return z.object({
        amount: z.number().nonnegative(),
        currency: currencySchema,
      });
    }

    case "date":
      return z.string().date();

    case "datetime":
      return z.string().datetime({ offset: true });

    case "boolean":
      return z.boolean();

    case "enum": {
      const opts = cfg["options"];
      const values = Array.isArray(opts)
        ? (opts as { value: string }[]).map((o) => o.value)
        : [];
      return values.length > 0
        ? z.enum(values as [string, ...string[]])
        : z.string();
    }

    case "multi_enum": {
      const opts = cfg["options"];
      const values = Array.isArray(opts)
        ? (opts as { value: string }[]).map((o) => o.value)
        : [];
      return values.length > 0
        ? z.array(z.enum(values as [string, ...string[]]))
        : z.array(z.string());
    }

    // user_ref values are AuthNexus user ids - opaque Snowflake-style
    // strings, not UUIDs (unlike entity_ref, which references another
    // entity instance's real Postgres UUID) - see authProvider.ts /
    // platform/users.ts / authnexus-management.ts, none of which produce
    // or expect a UUID-shaped id.
    case "user_ref":
      return z.string().min(1);

    case "entity_ref":
      return z.string().uuid();

    // The frontend (file-field-picker.tsx) has only ever submitted plain
    // file-id strings, matching the attachments-binding pattern used
    // elsewhere (POST /entities/:id/attachments with {fileId}) - never the
    // full {key,name,size,mimeType} object this schema used to require.
    case "file":
      return z.string().min(1);

    case "files": {
      const maxCount =
        typeof cfg["maxCount"] === "number" ? cfg["maxCount"] : 20;
      return z.array(z.string().min(1)).max(maxCount);
    }

    default:
      return z.unknown();
  }
}

export function transformZodErrors(error: z.ZodError): FieldError[] {
  return error.errors.map((issue) => {
    const meta = buildMeta(issue);
    const base: FieldError = {
      field: issue.path.join(".") || "_root",
      code: mapZodCode(issue),
      message: issue.message,
    };
    if (meta !== undefined) base.meta = meta;
    return base;
  });
}

function mapZodCode(issue: z.ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" ? "REQUIRED" : "INVALID_TYPE";
    case "too_small":
      return issue.type === "string" ? "TOO_SHORT" : "TOO_SMALL";
    case "too_big":
      return issue.type === "string" ? "TOO_LONG" : "TOO_LARGE";
    case "invalid_enum_value":
      return "INVALID_ENUM";
    case "invalid_string":
      return "INVALID_FORMAT";
    case "custom":
      return "VALIDATION_FAILED";
    default:
      return "INVALID";
  }
}

function buildMeta(issue: z.ZodIssue): Record<string, unknown> | undefined {
  if (issue.code === "too_big") return { max: issue.maximum };
  if (issue.code === "too_small") return { min: issue.minimum };
  if (issue.code === "invalid_enum_value") return { options: issue.options };
  return undefined;
}
