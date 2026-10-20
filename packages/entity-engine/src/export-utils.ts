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
  storageKey?: string;
  format: "csv" | "xlsx" | "pdf";
  rowCount: number;
  error?: string;
};

/**
 * GDPR data-subject export (docs/specs/user-data-export.md). Rides the same
 * queue as entity exports but is a distinct payload: it has no entity type and
 * must never be served by the agent-reachable entity-export download route.
 */
export type UserDataExportJobPayload = {
  kind: "user_data";
  tenantId: string;
  subjectUserId: string;
  requestedBy: string;
};

export type UserDataExportJobResult = {
  storageKey?: string;
  format: "json";
  rowCount: number;
  error?: string;
};

export type ExportQueuePayload = ExportJobPayload | UserDataExportJobPayload;
export type ExportQueueResult = ExportJobResult | UserDataExportJobResult;

export function isUserDataExportPayload(
  data: ExportQueuePayload,
): data is UserDataExportJobPayload {
  return "kind" in data;
}

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
