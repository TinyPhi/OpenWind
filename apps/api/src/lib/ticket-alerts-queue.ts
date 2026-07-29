/**
 * Producer-side handle for the "ticket-alerts" BullMQ queue (defined
 * worker-side in apps/worker/src/queues.ts — apps/api cannot import from
 * apps/worker per the dependency rule, so this mirrors export-queue.ts's
 * pattern of a same-named Queue instance for enqueue/remove calls only).
 * The API never processes jobs from this queue, only cancels them by their
 * deterministic id (`alert-{alertId}`) on edit/delete.
 */
import { Queue } from "bullmq";
import { connection } from "./redis.js";

export const ticketAlertsQueue = new Queue("ticket-alerts", { connection });

// BullMQ rejects custom job ids containing ":" ("Custom Id cannot contain :")
// — a dash separator avoids that, unlike sla-scheduler.ts's pre-existing
// `sla:{id}` scheme (a latent, currently-masked bug in that file, out of
// scope here).
export function ticketAlertJobId(alertId: string): string {
  return `alert-${alertId}`;
}
