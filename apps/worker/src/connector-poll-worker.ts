/**
 * connector-poll-worker.ts
 *
 * BullMQ consumer for the `connector-poll` queue (ADR-009 Decision #7, issue
 * #366) — the first real caller of packages/connector-sdk's
 * createConnectorContext() and a polling TriggerDefinition's `fetch()`.
 *
 * Per-job flow:
 *   1. Skip (no throw) if the tenant is inactive, the connector is no longer
 *      registered, its trigger is no longer `type: "polling"`, or the
 *      connector_credentials row no longer exists — all are races against
 *      connector-poll-scheduler.ts's reconcile tick, which will remove the
 *      stale repeatable job on its own next pass. None of these are this
 *      job's failure to report.
 *   2. Build a ConnectorContext via createConnectorContext() — this job never
 *      calls decryptCredential() directly, so the SSRF/allowedHosts guard in
 *      runtime.ts stays in the loop for whatever the connector's fetch()
 *      implementation does with ctx.callApi().
 *   3. Call trigger.polling.fetch(ctx, cursor). A throw here propagates and
 *      fails the job for BullMQ's attempts:3 retry — cursor_state is NOT
 *      advanced first, so a retry re-fetches from the same starting cursor.
 *   4. Forward every returned event onto connectorInboundQueue with the SAME
 *      job-data shape and jobId-for-idempotency convention the webhook
 *      gateway (apps/api/src/routes/webhooks/handler.ts) already uses —
 *      deliveryId is derived from (this poll job's own BullMQ `job.id`,
 *      event-index). `job.id` is stable across BullMQ's own retries of THIS
 *      scheduled occurrence (attempts:3 re-processes the same Job) but
 *      distinct for every subsequent scheduled occurrence of the repeatable
 *      job — unlike a cursor-based key, this stays correct even for a
 *      connector whose fetch() never advances cursor_state (e.g. a
 *      "list current open items" poller with no monotonic cursor), where a
 *      cursor-keyed id would silently collide across legitimate poll cycles
 *      and BullMQ would drop the new events as a no-op duplicate add().
 *   5. Only after every event is enqueued, advance cursor_state to
 *      { cursor: nextCursor } if the fetch returned one.
 */

import { Worker, type Job } from "bullmq";
import {
  connectorCredentials,
  connectorInstallationFilter,
  withTenantContext,
} from "@platform/db";
import {
  getConnectorDefinition,
  createConnectorContext,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "@platform/connector-sdk";
import { logger } from "@platform/logger";
import { connection, connectorInboundQueue } from "./queues.js";
import { validateActiveTenant } from "./tenant-guard.js";

const QUEUE_NAME = "connector-poll";

// A `fetch()` implementation is third-party-derived data crossing a trust
// boundary (security.md rule #2 — "connector data" requires validation
// before use), unlike ActionDefinition's output, which pairs a per-connector
// Zod schema with its own maxOutputBytes at the outbound boundary. Polling
// triggers have neither, so this worker enforces a flat cap itself before
// anything reaches connectorInboundQueue (which has no consumer/TTL yet —
// see queues.ts's own doc comment — making an unbounded producer here worse,
// not just noisy). A fetch() that violates either cap throws, failing this
// poll job outright rather than silently truncating/dropping some events.
const MAX_EVENTS_PER_POLL = 1000;

export interface ConnectorPollJobData {
  tenantId: string;
  connectorId: string;
}

interface CursorState {
  cursor?: string;
}

function isCursorState(value: unknown): value is CursorState {
  return typeof value === "object" && value !== null;
}

function derivePollEventId(bullJobId: string, index: number): string {
  return `${bullJobId}:${index}`;
}

async function processPollJob(job: Job<ConnectorPollJobData>): Promise<void> {
  const { tenantId, connectorId } = job.data;
  if (!job.id) {
    // Never happens for a job actually being processed (BullMQ always
    // assigns an id once a job exists in Redis) — narrows the type below.
    throw new Error("connector-poll-worker: job has no id");
  }
  const bullJobId = job.id;

  if (
    !(await validateActiveTenant(tenantId, "connector-poll-worker", {
      connectorId,
    }))
  ) {
    return;
  }

  const definition = getConnectorDefinition(connectorId);
  const trigger = definition?.triggers.find((t) => t.type === "polling");
  if (!definition || !trigger?.polling) {
    logger.warn(
      { tenantId, connectorId },
      "connector-poll-worker: connector or polling trigger no longer resolvable — skipping (reconciler will remove the stale job)",
    );
    return;
  }

  const [installation] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        secrets: connectorCredentials.secrets,
        cursorState: connectorCredentials.cursorState,
        disabledAt: connectorCredentials.disabledAt,
      })
      .from(connectorCredentials)
      .where(connectorInstallationFilter(tenantId, connectorId))
      .limit(1),
  );

  if (!installation) {
    logger.warn(
      { tenantId, connectorId },
      "connector-poll-worker: installation no longer exists — skipping (reconciler will remove the stale job)",
    );
    return;
  }

  if (installation.disabledAt) {
    // Kill switch (issue #367) — a race against the reconcile tick (a job
    // already scheduled before the installation was disabled can still
    // fire once). Skip, don't throw: the next reconcile tick removes this
    // job's repeatable schedule on its own, same as a deregistered
    // connector or a removed installation above.
    logger.info(
      { tenantId, connectorId },
      "connector-poll-worker: installation disabled — skipping poll",
    );
    return;
  }

  const cursorState = isCursorState(installation.cursorState)
    ? installation.cursorState
    : {};
  const cursorBeforePoll = cursorState.cursor;

  const ctx = createConnectorContext(
    tenantId,
    definition,
    installation.secrets as Record<string, string>,
  );

  const result = await trigger.polling.fetch(ctx, cursorBeforePoll);

  if (!Array.isArray(result.events)) {
    throw new Error(
      `connector-poll-worker: fetch() for connector ${connectorId} returned non-array events`,
    );
  }
  if (result.events.length > MAX_EVENTS_PER_POLL) {
    throw new Error(
      `connector-poll-worker: fetch() for connector ${connectorId} returned ${result.events.length} events, exceeding the cap of ${MAX_EVENTS_PER_POLL}`,
    );
  }

  for (const [index, event] of result.events.entries()) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (eventBytes > DEFAULT_MAX_OUTPUT_BYTES) {
      throw new Error(
        `connector-poll-worker: fetch() for connector ${connectorId} returned an event at index ${index} of ${eventBytes} bytes, exceeding the cap of ${DEFAULT_MAX_OUTPUT_BYTES}`,
      );
    }
    const deliveryId = derivePollEventId(bullJobId, index);
    await connectorInboundQueue.add(
      "connector.inbound",
      { tenantId, connectorId, deliveryId, event },
      { jobId: deliveryId },
    );
  }

  if (result.nextCursor !== undefined) {
    await withTenantContext(tenantId, (tx) =>
      tx
        .update(connectorCredentials)
        .set({ cursorState: { cursor: result.nextCursor } })
        .where(connectorInstallationFilter(tenantId, connectorId)),
    );
  }

  logger.info(
    { tenantId, connectorId, eventCount: result.events.length },
    "connector-poll-worker: poll complete",
  );
}

export const connectorPollWorker = new Worker<ConnectorPollJobData>(
  QUEUE_NAME,
  processPollJob,
  { connection },
);

connectorPollWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, data: job?.data, err },
    "connector-poll-worker: job failed",
  );
});

export async function stopConnectorPollWorker(): Promise<void> {
  await connectorPollWorker.close();
}
