import { and, eq, type SQL } from "drizzle-orm";
import { connectorCredentials } from "./schema/platform.js";

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
