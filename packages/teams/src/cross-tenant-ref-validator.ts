/**
 * cross-tenant-ref-validator.ts
 *
 * docs/specs/oncall-routing.md R1d/T44 — the shared, generic cross-tenant
 * FK validation helper. Postgres FK constraints alone do not enforce tenant
 * ownership (they only guarantee the referenced row exists SOMEWHERE, and FK
 * checks bypass RLS) -- any cross-table reference where the referenced table
 * is not itself the tenant-boundary column needs this app-layer check before
 * the write is issued.
 *
 * This generalizes the pattern already established in
 * packages/entity-engine/src/validation/ref-validator.ts's
 * validateEntityRefs/validateUserRefs -- same shape (collect refs, batch
 * lookup scoped to tenantId, diff, return FieldError[]), but table-agnostic:
 * the caller supplies a `lookupValidIds` function instead of this module
 * hardcoding a specific Drizzle table. This is what lets 3F's
 * temporal-scheduler track (docs/specs/temporal-scheduler.md R10b) reuse the
 * exact same validation shape for its own tables (schedule_rules.workflow_id,
 * template team_id/assignee_id/service_id) without a second implementation.
 *
 * Consumers of this module are expected to plug in their own Drizzle lookup
 * (a `SELECT id FROM <table> WHERE id IN (...) AND tenant_id = ...` batched
 * query) -- see `lookupValidIdsInTable` below for the common case.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@platform/db";

export type FieldError = {
  field: string;
  code: "INVALID_REFERENCE";
  message: string;
  meta: { refId: string };
};

export type CrossTenantRefCheck = {
  /** The field name to report the error against (e.g. "teamId"). */
  fieldName: string;
  /** The referenced row's id, as submitted by the caller. */
  refId: string;
};

/**
 * Validates that every ref in `refs` resolves to a row `lookupValidIds`
 * confirms belongs to the current tenant. Table-agnostic: the caller decides
 * what "valid" means by supplying the lookup.
 *
 * @param refs           — refs to validate; refs with an empty/missing refId
 *                          should be filtered out by the caller before
 *                          calling this (this function assumes every entry
 *                          in `refs` is a real, non-empty id that needs
 *                          checking)
 * @param lookupValidIds — given the full list of refIds being checked,
 *                          returns the subset that exist AND belong to the
 *                          current tenant
 * @returns                array of FieldErrors; empty means all refs are valid
 */
export async function validateCrossTenantRefs(
  refs: CrossTenantRefCheck[],
  lookupValidIds: (refIds: string[]) => Promise<Set<string>>,
): Promise<FieldError[]> {
  if (refs.length === 0) return [];

  // Dedupe before the batch lookup -- two refs (different fieldNames) can
  // legitimately point at the same resource, and there's no reason to ask
  // the lookup to check the same id twice (PR #583 review, S1).
  const refIds = [...new Set(refs.map((r) => r.refId))];
  const validIdSet = await lookupValidIds(refIds);

  const errors: FieldError[] = [];
  for (const { fieldName, refId } of refs) {
    if (!validIdSet.has(refId)) {
      errors.push({
        field: fieldName,
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId },
      });
    }
  }
  return errors;
}

/**
 * Convenience wrapper for the common case: the referenced table has a plain
 * `id` primary key column and a `tenant_id` column. Returns a
 * `lookupValidIds` function suitable for passing straight into
 * `validateCrossTenantRefs`.
 *
 * IMPORTANT (PR #583 review, blocker 3): pass `softDeleteColumn` whenever the
 * referenced table has soft-delete semantics -- which is every table in this
 * repo. Without it, a soft-deleted row (still present, still tenant-matched)
 * is indistinguishable from a live one and will validate as "valid,"
 * silently letting new writes reference an archived resource (e.g. a new
 * on_call_schedule pointing at a soft-deleted team). Omit it only for a
 * table you've confirmed has no `deleted_at`-style column at all.
 *
 * Example (validating services.team_id against teams):
 *   const lookup = lookupValidIdsInTable(
 *     db, teams, teams.id, teams.tenantId, teams.deletedAt, tenantId,
 *   );
 *   const errors = await validateCrossTenantRefs(
 *     [{ fieldName: "teamId", refId: input.teamId }],
 *     lookup,
 *   );
 */
export function lookupValidIdsInTable(
  db: DbOrTx,
  table: AnyPgTable,
  idColumn: AnyPgColumn,
  tenantColumn: AnyPgColumn,
  softDeleteColumn: AnyPgColumn | undefined,
  tenantId: string,
): (refIds: string[]) => Promise<Set<string>> {
  return async (refIds: string[]): Promise<Set<string>> => {
    const conditions = [inArray(idColumn, refIds), eq(tenantColumn, tenantId)];
    if (softDeleteColumn) {
      conditions.push(isNull(softDeleteColumn));
    }
    const rows = await db
      .select({ id: idColumn })
      .from(table)
      .where(and(...conditions));
    return new Set(rows.map((r) => r.id as string));
  };
}
