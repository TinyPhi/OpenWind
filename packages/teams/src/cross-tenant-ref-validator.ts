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

import { and, eq, inArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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

  const refIds = refs.map((r) => r.refId);
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
 * Example (validating services.team_id against teams):
 *   const lookup = lookupValidIdsInTable(db, teams, teams.id, teams.tenantId, tenantId);
 *   const errors = await validateCrossTenantRefs(
 *     [{ fieldName: "teamId", refId: input.teamId }],
 *     lookup,
 *   );
 */
export function lookupValidIdsInTable(
  db: DbOrTx,
  // Drizzle's typed `.from()` can't be expressed generically over an
  // arbitrary pgTable without a much heavier generic signature; this helper
  // trades a small amount of type safety at the call site for genuine
  // table-agnosticism -- the whole point of "generalize this helper" per
  // R1d/T44 (see this file's header comment). Callers pass a concrete
  // Drizzle table object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  idColumn: AnyPgColumn,
  tenantColumn: AnyPgColumn,
  tenantId: string,
): (refIds: string[]) => Promise<Set<string>> {
  return async (refIds: string[]): Promise<Set<string>> => {
    const rows = await db
      .select({ id: idColumn })
      .from(table)
      .where(and(inArray(idColumn, refIds), eq(tenantColumn, tenantId)));
    return new Set(rows.map((r) => r.id as string));
  };
}
