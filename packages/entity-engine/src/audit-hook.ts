/**
 * audit-hook.ts
 *
 * Lightweight hook mechanism that lets the entity engine fire an audit callback
 * after every create / update / delete mutation — without importing @platform/audit
 * (which would violate the packages/entity-engine → packages/db only dependency rule).
 *
 * Usage (at app startup, in apps/api):
 *
 *   import { registerEntityAuditHook } from "@platform/entity-engine";
 *   import { writeAuditEntry } from "@platform/audit";
 *
 *   registerEntityAuditHook(async (p) => {
 *     await writeAuditEntry(p.db, {
 *       tenantId: p.tenantId,
 *       actorId:  p.actorId,
 *       actorType: p.actorType,
 *       ...
 *     });
 *   });
 *
 * The hook receives the same `db` / `tx` that was passed into the engine function,
 * so the audit INSERT participates in the caller's transaction when present.
 *
 * Errors thrown by the hook propagate to the engine caller — they are NOT silently
 * swallowed. Register a hook that handles its own errors if you need fire-and-forget.
 */

import type { DbOrTx } from "@platform/db";

/** Matches FieldSensitivity in types.ts — duplicated here to avoid a circular import. */
export type AuditFieldSensitivity = "public" | "internal" | "pii" | "financial";

export type EntityAuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "transitioned"
  | "restored";

export type EntityAuditActorType = "user" | "api_key" | "system";

export type EntityAuditHookParams = {
  /** The same db/tx reference passed to the engine function — reuse to stay in the same transaction. */
  db: DbOrTx;
  tenantId: string;
  actorId: string;
  actorType: EntityAuditActorType;
  /** ADR-012 Phase B, spec R9/GAP-05 — the real person acting through a third-party API key (actorId/actorType above), distinct so search-by-person and search-by-key both work independently. Undefined for every non-third-party actor. */
  actingPersonId?: string | undefined;
  /** Human-readable entity type name, e.g. "ticket" */
  resourceType: string;
  resourceId: string;
  action: EntityAuditAction;
  /** Raw (unredacted) field values before mutation, or null for "created" actions. */
  beforeSnapshot: Record<string, unknown> | null;
  /** Raw (unredacted) field values after mutation, or null for "deleted" actions. */
  afterSnapshot: Record<string, unknown> | null;
  /** Full field list for the entity type — used by the hook for PII redaction. */
  entityFields: ReadonlyArray<{
    name: string;
    sensitivity: AuditFieldSensitivity;
  }>;
};

export type EntityAuditHookFn = (
  params: EntityAuditHookParams,
) => Promise<void>;

let _hook: EntityAuditHookFn | undefined;

/**
 * Register the function called after every entity mutation.
 * Subsequent calls replace the previous hook (only one hook is supported).
 * Call this once at application startup from apps/api.
 */
export function registerEntityAuditHook(fn: EntityAuditHookFn): void {
  _hook = fn;
}

/** @internal — exposed for testing only. Resets the registered hook. */
export function _resetEntityAuditHook(): void {
  _hook = undefined;
}

/** Returns true if a hook is currently registered. */
export function isEntityAuditHookRegistered(): boolean {
  return _hook !== undefined;
}

/**
 * Fire the registered hook (if any) with the given params.
 * No-op when no hook is registered (e.g. in tests that don't register one).
 */
export async function fireEntityAuditHook(
  params: EntityAuditHookParams,
): Promise<void> {
  if (_hook !== undefined) {
    await _hook(params);
  }
}
