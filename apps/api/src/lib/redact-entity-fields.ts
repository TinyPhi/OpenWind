import { eq, and, or, isNull } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityFields } from "@platform/db";
import {
  buildSensitivityMap,
  redactMetadata,
  type FieldSensitivity,
} from "@platform/workflow-engine";

/**
 * ADR-012 Phase G, spec R7 — redacts pii/financial fields per
 * entity_fields.sensitivity before a third-party read response is sent.
 * Reuses the SAME redactMetadata/buildSensitivityMap mechanism already
 * used by writeAuditEntry's snapshot redaction and
 * apps/worker/src/connector-outbound-worker.ts's outbound-payload
 * redaction (PR #393) — not a second, parallel redaction implementation.
 *
 * Returns the payload unchanged when there's nothing to redact against
 * (no entityTypeId, or an empty payload) — deny-by-default doesn't apply
 * here the way it does for connector delivery (ADR-009 Decision #10);
 * there's simply no sensitivity map to redact with.
 */
export async function redactEntityFieldsForThirdParty(
  tx: DbOrTx,
  tenantId: string,
  entityTypeId: string | undefined | null,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!entityTypeId || Object.keys(payload).length === 0) return payload;

  const fieldRows = await tx
    .select({ name: entityFields.name, sensitivity: entityFields.sensitivity })
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityTypeId),
        // NULL tenantId = system field shared by every tenant using this
        // entity type; a real tenantId = one tenant's own custom field
        // addition (matches workflow-engine/src/engine.ts's own query).
        or(isNull(entityFields.tenantId), eq(entityFields.tenantId, tenantId)),
      ),
    );

  const sensitivityMap = buildSensitivityMap(
    fieldRows.map((r) => ({
      name: r.name,
      sensitivity: r.sensitivity as FieldSensitivity,
    })),
  );

  return redactMetadata(payload, sensitivityMap);
}
