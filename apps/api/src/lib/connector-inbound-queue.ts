/**
 * Producer-side handle for the "connector-inbound" BullMQ queue (defined
 * worker-side in apps/worker/src/queues.ts — apps/api cannot import from
 * apps/worker per the dependency rule, so this mirrors ticket-alerts-queue.ts's
 * pattern of a same-named Queue instance for enqueue calls only).
 * No worker consumer exists yet (issue #364's scope is the producer/gateway
 * side only) — jobs published here queue up in Redis until #368's connectors
 * give a future consumer something to do.
 */
import { Queue } from "bullmq";
import { connection } from "./redis.js";

export const connectorInboundQueue = new Queue("connector-inbound", {
  connection,
});

export interface ConnectorInboundJobData {
  tenantId: string;
  connectorId: string;
  deliveryId: string;
  event: Record<string, unknown>;
}
