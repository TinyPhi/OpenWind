import type { EntityField, EntityInstance } from "./types.js";

// ── Job types ─────────────────────────────────────────────────────────────────
// Canonical definitions shared by apps/api (enqueue) and apps/worker (consume).
// Neither app may redefine these — import from @platform/entity-engine instead.

export type ExportJobPayload = {
  tenantId: string;
  entityTypeId: string;
  format: "csv" | "xlsx" | "pdf";
  filters: { state?: string; assignedTo?: string };
  requestedBy: string;
  requestedByRoles?: string[];
  includePii?: boolean;
};

export const PII_EXPORT_ROLES = new Set(["pii_export", "admin", "superadmin"]);

export type ExportJobResult = {
  downloadUrl: string;
  format: "csv" | "xlsx" | "pdf";
  rowCount: number;
  error?: string;
};

// ── Row serialisation ─────────────────────────────────────────────────────────

export function buildExportRow(
  instance: EntityInstance,
  fields: EntityField[],
): string[] {
  return [
    instance.id,
    instance.currentState,
    instance.createdAt.toISOString(),
    instance.updatedAt.toISOString(),
    ...fields.map((f) => {
      const v = instance.fields[f.name];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    }),
  ];
}
