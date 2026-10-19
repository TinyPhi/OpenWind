import { and, eq, type SQL } from "drizzle-orm";
import {
  connectorCredentials,
  connectorDefinitions,
} from "./schema/platform.js";
import type { DbOrTx } from "./middleware.js";

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
 * Whether a connector definition with this id exists. A single indexed
 * lookup (`WHERE id = $1 LIMIT 1`), so callers outside this package, such as
 * the credential:set admin CLI, don't need drizzle-orm's operators or a
 * full read of the catalog (#960). connector_definitions is the platform-wide
 * catalog: no tenant_id, no RLS.
 */
export async function connectorDefinitionExists(
  executor: DbOrTx,
  connectorId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: connectorDefinitions.id })
    .from(connectorDefinitions)
    .where(eq(connectorDefinitions.id, connectorId))
    .limit(1);
  return row !== undefined;
}
