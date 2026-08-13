/**
 * registry.ts
 *
 * In-process registry mapping a connector id to its ConnectorDefinition
 * (ADR-009 Decision #6: v1's trust boundary is first-party, hand-built,
 * in-process connector code — there is no external submission/loading
 * mechanism, so a plain in-memory Map is the right amount of infrastructure).
 *
 * Why this exists: the outbound delivery worker (apps/worker, issue #365)
 * must validate a connector action's output against its *declared Zod
 * schema* (ActionDefinition.output) and declared max size (Decision #10)
 * immediately before every delivery attempt. A BullMQ job's data crosses a
 * Redis serialization boundary, so it can only ever carry the plain-JSON
 * candidate payload — never the Zod schema itself. Something in-process has
 * to resolve "connector X's action Y" back to its real ConnectorDefinition
 * object at delivery time; this registry is that seam.
 *
 * Each concrete connector package (e.g. the future email/WhatsApp connectors,
 * issue #368) is expected to call registerConnector() with its definition at
 * module load time. No connector registers today — v1 email/WhatsApp
 * connectors are a separate, not-yet-built issue — so the registry is
 * legitimately empty in every environment right now; callers that need a
 * definition and don't find one should fail closed (see
 * connector-outbound-worker.ts), not silently skip validation.
 */

import type { ConnectorDefinition } from "./types.js";

const registry = new Map<string, ConnectorDefinition>();

export function registerConnector(definition: ConnectorDefinition): void {
  registry.set(definition.meta.id, definition);
}

export function getConnectorDefinition(
  connectorId: string,
): ConnectorDefinition | undefined {
  return registry.get(connectorId);
}

/** Test-only — clears every registered connector so test files don't leak state into each other. */
export function __resetConnectorRegistryForTests(): void {
  registry.clear();
}
