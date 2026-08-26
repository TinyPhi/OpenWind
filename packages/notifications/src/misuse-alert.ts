import type { DbOrTx } from "@platform/db";
import { outboxEvents } from "@platform/db";

/**
 * ADR-012 Phase F, spec R4 — fires an admin-visible alert through the
 * platform's EXISTING notification channel (ADR-014 Decision #3: "an admin
 * alert delivery channel already exists — it doesn't need to be built").
 * Writes a `system.error` outbox event, exactly the shape
 * apps/worker/src/av-scan.ts's scan-failure path already writes — the
 * worker's existing outbox-poller -> resolveRecipients("system.error") ->
 * sendNotification chain (and the admin-ui System Logs screen) already
 * consume this, so this phase adds zero new delivery infrastructure.
 *
 * `deliveredAt` is stamped immediately (dead-lettered by design, same as
 * av-scan.ts) -- system.error isn't an automation trigger and has no other
 * consumer waiting on outbox-poller to pick it up.
 */
export async function fireMisuseAlert(
  tx: DbOrTx,
  tenantId: string,
  reason: string,
  context: Record<string, unknown>,
): Promise<void> {
  await tx.insert(outboxEvents).values({
    tenantId,
    eventType: "system.error",
    version: 1,
    payload: {
      eventType: "system.error",
      version: 1,
      tenantId,
      context,
      reason,
    },
    deliveredAt: new Date(),
  });
}
