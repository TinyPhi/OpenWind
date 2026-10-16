import { and, eq, type SQL } from "drizzle-orm";
import { db } from "./client.js";
import {
  connectorCredentials,
  connectorDefinitions,
} from "./schema/platform.js";

/**
 * The (tenant_id, connector_id) composite filter every connector_credentials
 * consumer needs — issue #367's kill switch review found this predicate
 * copy-pasted verbatim across the webhook gateway, the outbound delivery
 * worker, and the polling worker (twice) as each independently learned to
 * check disabled_at. One place to update when this table's identity shape
 * changes again (it already has, twice: secrets -> cursor_state -> disabled_at).
 */
export function connectorInstallationFilter(
  tenantId: string,
  connectorId: string,
): SQL | undefined {
  return and(
    eq(connectorCredentials.tenantId, tenantId),
    eq(connectorCredentials.connectorId, connectorId),
  );
}

/**
 * Whether `connectorId` is an entry in the platform-wide connector catalog: one indexed
 * lookup, not a read of the whole table. connector_definitions has no tenant_id and no RLS
 * (one row per connector type the platform ships), so the plain `db` handle is the right one.
 * `connectorId` must be a UUID: Postgres rejects anything else on a uuid column.
 *
 * Lives here, not in scripts/, because scripts/ has no drizzle-orm dependency to import
 * `eq` from, and operators from another copy of drizzle-orm don't typecheck against this
 * package's built column types.
 */
export async function connectorDefinitionExists(
  connectorId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: connectorDefinitions.id })
    .from(connectorDefinitions)
    .where(eq(connectorDefinitions.id, connectorId))
    .limit(1);
  return row !== undefined;
}
