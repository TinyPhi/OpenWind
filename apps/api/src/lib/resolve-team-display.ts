import { eq, and, isNull } from "drizzle-orm";
import { teams, withTenantContext } from "@platform/db";

/**
 * Resolves an entity's `fields.team_id` (the JSONB slot the team-assign/
 * on-call feature writes for any entity type — docs/specs/team-assign-
 * oncall-fallback.md, docs/specs/schedule-rules-mandate-fields.md) to the
 * team's live display name, the same "resolve on read, never store a
 * denormalized copy" pattern resolve-origin-display.ts uses for
 * origin_oidc_client_id. `team_id` is a plain generic field on every entity
 * type (no dedicated "team reference" field type exists), so this resolves
 * it server-side rather than adding new field-type machinery — a rename
 * shows immediately, without a migration.
 *
 * Falls back to the raw id (never throws) if the team has since been
 * deleted — a read endpoint must never 500 because of stale data on an old
 * record.
 */
export async function resolveTeamDisplayName(
  tenantId: string,
  fields: Record<string, unknown>,
): Promise<string | null> {
  const teamId = fields["team_id"];
  if (typeof teamId !== "string" || !teamId) return null;

  const [team] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ name: teams.name })
      .from(teams)
      .where(
        and(
          eq(teams.id, teamId),
          eq(teams.tenantId, tenantId),
          isNull(teams.deletedAt),
        ),
      )
      .limit(1),
  );
  return team?.name ?? teamId;
}
