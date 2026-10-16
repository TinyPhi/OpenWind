/**
 * Database lookups behind the mandatory-fields rule (docs/specs/mandatory-ticket-fields.md
 * R4): which records are workflow records, and the tenant checks on the team and the
 * workflow a record is created with. A rejected reference is a 422 field error, never an
 * existence leak (db-conventions: cross-table references).
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { teams, workflows } from "@platform/db";
import { ValidationError } from "./errors.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A team assignment must name a live team of this tenant. */
export async function assertTeamInTenant(
  db: DbOrTx,
  tenantId: string,
  teamId: string,
): Promise<void> {
  const invalid = new ValidationError([
    { field: "teamId", code: "invalid", message: "Unknown team" },
  ]);
  if (!UUID_RE.test(teamId)) throw invalid;
  const [row] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.id, teamId),
        eq(teams.tenantId, tenantId),
        isNull(teams.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw invalid;
}

/**
 * A record's workflow must be one this tenant can see (its own, or a global template) and
 * must run the record's own entity type.
 */
export async function assertWorkflowMatchesType(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  entityTypeId: string,
): Promise<void> {
  const [row] = UUID_RE.test(workflowId)
    ? await db
        .select({ entityTypeId: workflows.entityTypeId })
        .from(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            or(eq(workflows.tenantId, tenantId), isNull(workflows.tenantId)),
          ),
        )
        .limit(1)
    : [];
  if (row?.entityTypeId !== entityTypeId) {
    throw new ValidationError([
      {
        field: "workflowId",
        code: "invalid",
        message: "The workflow doesn't belong to this entity type",
      },
    ]);
  }
}

/**
 * True when this tenant's entity type has an active workflow, so its records are workflow
 * records even when a caller leaves workflowId out.
 */
export async function entityTypeHasWorkflow(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.entityTypeId, entityTypeId),
        or(eq(workflows.tenantId, tenantId), isNull(workflows.tenantId)),
        eq(workflows.isActive, true),
      ),
    )
    .limit(1);
  return row !== undefined;
}
