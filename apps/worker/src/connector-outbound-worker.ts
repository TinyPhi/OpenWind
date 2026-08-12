/**
 * connector-outbound-worker.ts
 *
 * BullMQ consumer for the `connector-outbound` queue (ADR-009 Decisions #9/#10,
 * issue #365) — delivers a signed event envelope to a connector installation's
 * configured target URL, with a full attempt-tracking record.
 *
 * Per-attempt order of operations (every one of these re-runs on EVERY retry,
 * not just the first attempt — a cached "validated once" result is not
 * acceptable, since the target URL, connector definition, or entity field
 * sensitivity config can all change between retries of the same logical
 * delivery):
 *   1. Insert a 'pending' connector_delivery_attempts row (crash visibility —
 *      if the process dies mid-attempt, the row still shows an attempt was
 *      in flight, rather than nothing at all).
 *   2. Resolve the ConnectorDefinition + ActionDefinition from the in-process
 *      registry (packages/connector-sdk/src/registry.ts) — fails closed if
 *      either is unregistered (no connector code, no `output` schema to
 *      validate against, so nothing can be safely delivered).
 *   3. AC6 — validate the RAW candidate payload against the action's declared
 *      Zod `output` schema and declared max size (integrity/DoS control).
 *   4. AC5 — redact pii/financial field values (packages/workflow-engine's
 *      existing, already-tested redactMetadata/buildSensitivityMap — reused,
 *      not reimplemented) using entity_fields.sensitivity for the payload's
 *      entityTypeId, when one is given. Deny-by-default: if entityTypeId is
 *      given but the field lookup can't run, delivery is NOT sent — see the
 *      inline comment at the redaction call site for why this direction is
 *      chosen over fail-open.
 *
 *      GENUINE OPEN GAP (flagged per this issue's instructions, not solved
 *      here): ADR-009 Decision #10 also describes an "explicit per-connector
 *      grant to cross the tenant boundary" for pii/financial fields — i.e.
 *      redaction should be the ONLY thing that runs unless a connector has
 *      been explicitly granted permission to receive a given sensitive field
 *      unredacted. No such grant has a storage mechanism anywhere in this
 *      schema today (no column, no table). This worker implements the
 *      deny-by-default half (always redact) and does NOT invent a grant
 *      table/column — that's a separate design decision for a human to make
 *      (which fields, how stored, how checked).
 *
 *      SECOND OPEN GAP (found during security review, not solved here):
 *      redactMetadata/buildSensitivityMap were built for workflow_events.metadata,
 *      a flat, tightly-controlled shape — by their own documented contract, only
 *      top-level keys are checked, nested objects are not traversed, and a key
 *      with no match in the sensitivity map passes through unmodified (fail-open,
 *      not fail-closed). Reused here against an arbitrary connector action's
 *      declared `output` shape, this is safe only as long as every real connector
 *      emits a flat object whose keys exactly match `entity_fields.name` for the
 *      given `entityTypeId`. A connector that nests entity data one level deep,
 *      or renames a field relative to `entity_fields.name`, will have that value
 *      silently pass through unredacted with no error or signal. No registered
 *      connector exists yet to violate this (issue #368's email/WhatsApp
 *      connectors are the first real consumers) — whoever builds the first real
 *      `output` schema must either keep it flat and field-name-matched, or this
 *      redaction step needs to become recursive / registration-time-validated
 *      before that connector ships.
 *   5. AC4 — mandatory per-attempt SSRF validation via
 *      packages/connector-sdk's assertEgressAllowed (the #362-built guard,
 *      reused rather than porting a third copy — see PROGRESS.md for why
 *      this one was picked over automation-engine's ssrf-guard.ts).
 *   6. AC3 — build the versioned envelope, sign it (HMAC-SHA256 over
 *      `timestamp.rawBody`), attach the delivery-id header, and deliver via
 *      node:http(s).request with the connection pinned to the exact IP
 *      assertEgressAllowed validated (same DNS-rebinding defense as
 *      automation-engine/src/actions/webhook.ts and connector-sdk/runtime.ts
 *      — global fetch/Undici silently ignores the `agent` option).
 *   7. Update the connector_delivery_attempts row to a terminal status for
 *      this attempt ('success', 'failed' with next_retry_at, or 'exhausted'
 *      on the final configured attempt) and, on 'exhausted', write a
 *      dead_letter_events row too — connector_delivery_attempts is the
 *      per-attempt log LEADING UP TO that terminal case, not a replacement
 *      for the platform's one existing terminal-failure sink. A redrive
 *      UI/API over either table is explicitly out of scope for this issue.
 */

import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { Worker, type Job } from "bullmq";
import { eq, and, or, isNull } from "drizzle-orm";
import {
  db,
  withTenantContext,
  entityFields,
  connectorDeliveryAttempts,
  deadLetterEvents,
} from "@platform/db";
import { buildSensitivityMap, redactMetadata } from "@platform/workflow-engine";
import type { FieldSensitivity } from "@platform/entity-engine";
import {
  getConnectorDefinition,
  assertEgressAllowed,
  buildOutboundEnvelope,
  signOutboundRequest,
  validateActionOutput,
} from "@platform/connector-sdk";
import { decryptCredential } from "@platform/secrets";
import { logger } from "@platform/logger";
import { connection, connectorOutboundQueue } from "./queues.js";
import { validateActiveTenant } from "./tenant-guard.js";

const QUEUE_NAME = "connector-outbound";
const DELIVERY_TIMEOUT_MS = 15_000;

export interface ConnectorOutboundJobData {
  tenantId: string;
  connectorId: string;
  actionId: string;
  targetUrl: string;
  eventType: string;
  /** Raw, pre-redaction candidate payload — see module doc for why redaction runs per-attempt, not once at enqueue time. */
  payload: Record<string, unknown>;
  /** OpenBao ciphertext for the HMAC signing secret shared with the connector installation's receiving endpoint. */
  signingSecretCiphertext: string;
  /** Entity type whose entity_fields.sensitivity governs redaction of `payload`. Omit if the payload isn't entity-field-shaped (nothing to redact against). */
  entityTypeId?: string;
  /** Stable across every retry of the same logical delivery — generated by enqueueConnectorDelivery() if not supplied. */
  deliveryId: string;
}

/**
 * Producer-facing entry point. No caller exists yet in this codebase — the
 * actual trigger source (polling scheduler #366, a built connector #368, or
 * ADR-010's future event_subscriptions) is separate, not-yet-built work.
 * This function is the integration seam those will call.
 */
export async function enqueueConnectorDelivery(
  data: Omit<ConnectorOutboundJobData, "deliveryId"> & { deliveryId?: string },
): Promise<string> {
  const deliveryId = data.deliveryId ?? randomUUID();
  await connectorOutboundQueue.add(
    data.eventType,
    { ...data, deliveryId },
    // jobId = deliveryId: a caller retrying the same logical enqueue (e.g.
    // after a crash before this call returned) is deduplicated by BullMQ
    // rather than producing a second, parallel delivery — same convention as
    // outbox-poller.ts's jobId = outbox event id.
    { jobId: deliveryId },
  );
  return deliveryId;
}

async function insertPendingAttempt(
  tenantId: string,
  connectorId: string,
  deliveryId: string,
  attemptNumber: number,
): Promise<string> {
  const [row] = await withTenantContext(tenantId, (tx) =>
    tx
      .insert(connectorDeliveryAttempts)
      .values({
        tenantId,
        connectorId,
        deliveryId,
        status: "pending",
        attemptNumber,
      })
      .returning({ id: connectorDeliveryAttempts.id }),
  );
  if (!row) {
    throw new Error("Failed to insert connector_delivery_attempts row");
  }
  return row.id;
}

async function finalizeAttempt(
  tenantId: string,
  attemptRowId: string,
  update: {
    status: "success" | "failed" | "exhausted";
    latencyMs: number;
    error?: string;
    nextRetryAt?: Date;
  },
): Promise<void> {
  await withTenantContext(tenantId, (tx) =>
    tx
      .update(connectorDeliveryAttempts)
      .set({
        status: update.status,
        latencyMs: update.latencyMs,
        error: update.error ?? null,
        nextRetryAt: update.nextRetryAt ?? null,
      })
      .where(
        and(
          eq(connectorDeliveryAttempts.id, attemptRowId),
          eq(connectorDeliveryAttempts.tenantId, tenantId),
        ),
      ),
  );
}

/**
 * Redacts pii/financial fields per entity_fields.sensitivity (AC5). Returns
 * the raw payload unchanged when no entityTypeId is given — there is no
 * sensitivity map to redact against, so there is nothing this step can (or
 * should silently invent) protect. When entityTypeId IS given, this always
 * runs before the payload is signed/sent — deny-by-default, per ADR-009
 * Decision #10, since no per-connector grant mechanism exists yet (see
 * module doc).
 */
async function redactForDelivery(
  tenantId: string,
  entityTypeId: string | undefined,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!entityTypeId || Object.keys(payload).length === 0) return payload;

  const fieldRows = await db
    .select({ name: entityFields.name, sensitivity: entityFields.sensitivity })
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityTypeId),
        // Explicit tenantId guard (matches workflow-engine/src/engine.ts's
        // own sensitivity-map query exactly) — entity_fields rows with a
        // NULL tenantId are system fields shared by every tenant using this
        // entity type; rows with a real tenantId are one tenant's own custom
        // field additions to that (possibly shared) entity type.
        or(isNull(entityFields.tenantId), eq(entityFields.tenantId, tenantId)),
      ),
    );

  const sensitivityMap = buildSensitivityMap(
    fieldRows.map((r) => ({
      name: r.name,
      // entity_fields.sensitivity has a DB CHECK constraint guaranteeing one
      // of the four FieldSensitivity literals (same cast workflow-engine's
      // engine.ts makes at its own call site).
      sensitivity: r.sensitivity as FieldSensitivity,
    })),
  );

  return redactMetadata(payload, sensitivityMap);
}

async function deliver(
  targetUrl: string,
  headers: Record<string, string>,
  rawBody: string,
  validatedIp: string,
): Promise<void> {
  const isHttps = targetUrl.startsWith("https:");
  const family = validatedIp.includes(":") ? 6 : 4;
  // Same happy-eyeballs-aware lookup shape as automation-engine's
  // webhook.ts / connector-sdk's runtime.ts — the two call shapes (array vs
  // bare string) are both exercised by Node's net module depending on
  // whether opts.all is set.
  const lookupFn = (
    _hostname: string,
    opts: { all?: boolean },
    callback: (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    if (opts.all) {
      callback(null, [{ address: validatedIp, family }]);
    } else {
      callback(null, validatedIp, family);
    }
  };
  const agent = isHttps
    ? new https.Agent({ lookup: lookupFn as never })
    : new http.Agent({ lookup: lookupFn as never });

  await new Promise<void>((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const req = (isHttps ? https : http).request(
      {
        method: "POST",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "OpenWind-Connector-Outbound/1.0",
          "Content-Length": Buffer.byteLength(rawBody),
          ...headers,
        },
        agent,
        timeout: DELIVERY_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        if (status < 200 || status >= 300) {
          reject(new Error(`connector delivery received non-2xx: ${status}`));
          return;
        }
        resolve();
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("connector delivery timed out"));
    });
    req.on("error", (err) => {
      reject(new Error(`connector delivery network error: ${String(err)}`));
    });
    req.write(rawBody);
    req.end();
  });
}

async function processJob(job: Job<ConnectorOutboundJobData>): Promise<void> {
  const {
    tenantId,
    connectorId,
    actionId,
    targetUrl,
    eventType,
    payload,
    signingSecretCiphertext,
    entityTypeId,
    deliveryId,
  } = job.data;

  const active = await validateActiveTenant(tenantId, "Connector delivery", {
    connectorId,
    deliveryId,
    jobId: job.id,
  });
  if (!active) return;

  const attemptNumber = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  const isLastAttempt = attemptNumber >= maxAttempts;

  const attemptRowId = await insertPendingAttempt(
    tenantId,
    connectorId,
    deliveryId,
    attemptNumber,
  );
  const startedAt = Date.now();
  // Mirrors `payload` until Step 4 (AC5) computes the real redacted form —
  // used by the dead-letter write below so an exhausted delivery never
  // persists an unredacted pii/financial value merely because the failure
  // (SSRF block, network error, non-2xx) happened after redaction ran.
  let payloadForDeadLetter: unknown = payload;

  try {
    // Step 2 — resolve connector + action from the in-process registry.
    // Fails closed: no ActionDefinition means no `output` schema to validate
    // against, and this worker never sends anything it hasn't validated.
    const definition = getConnectorDefinition(connectorId);
    if (!definition) {
      throw new Error(
        `Connector "${connectorId}" is not registered in this process`,
      );
    }
    const action = definition.actions.find((a) => a.id === actionId);
    if (!action) {
      throw new Error(`Connector "${connectorId}" has no action "${actionId}"`);
    }

    // Step 3 (AC6) — validate the RAW payload against the declared schema +
    // size BEFORE redaction. Redaction can turn a typed field (e.g. a
    // number) into the literal string "[REDACTED]", which would fail this
    // same schema — validating the pre-redaction shape is what actually
    // proves the producer sent well-formed data; redaction is a
    // transmission-time confidentiality transform applied after that proof,
    // not a second shape to validate against.
    const validation = validateActionOutput(action, payload);
    if (!validation.ok) {
      throw new Error(`payload validation failed: ${validation.reason}`);
    }

    // Step 4 (AC5) — redact pii/financial fields. Deny-by-default: always
    // runs when entityTypeId is given; see module doc for the open grant gap.
    const validatedRecord = validation.data as Record<string, unknown>;
    const redacted = await redactForDelivery(
      tenantId,
      entityTypeId,
      validatedRecord,
    );
    payloadForDeadLetter = redacted;

    // Step 5 (AC4) — mandatory per-attempt SSRF re-validation. Never cached
    // across attempts: targetUrl could have been reconfigured to point at an
    // internal target since the last attempt.
    const validatedIp = await assertEgressAllowed(targetUrl);

    // Step 6 (AC3) — envelope, signing, delivery-id, pinned delivery.
    const envelope = buildOutboundEnvelope({
      deliveryId,
      eventType,
      tenantId,
      connectorId,
      data: redacted,
    });
    const rawBody = JSON.stringify(envelope);
    const secret = await decryptCredential(tenantId, signingSecretCiphertext);
    const headers = signOutboundRequest(secret, rawBody, deliveryId);

    logger.info(
      { tenantId, connectorId, deliveryId, attemptNumber, eventType },
      "connector-outbound: dispatching delivery attempt",
    );

    await deliver(targetUrl, headers, rawBody, validatedIp);

    await finalizeAttempt(tenantId, attemptRowId, {
      status: "success",
      latencyMs: Date.now() - startedAt,
    });
    logger.info(
      { tenantId, connectorId, deliveryId, attemptNumber },
      "connector-outbound: delivery succeeded",
    );
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);

    if (isLastAttempt) {
      await finalizeAttempt(tenantId, attemptRowId, {
        status: "exhausted",
        latencyMs,
        error: message,
      });
      // R14-style convention (notification-outbound-worker.ts): a
      // permanently failed delivery is never silently dropped — it lands in
      // the platform's one existing terminal-failure sink. Uses
      // withTenantContext — migration 0049 re-enabled RLS on
      // dead_letter_events (0006's "RLS disabled by design" no longer holds),
      // matching automation-worker.ts's own dead-letter insert, which already
      // does this "defensive against any future RLS reinstatement". Persists
      // `payloadForDeadLetter` (the redacted form once Step 4 has run), never
      // the raw `payload` — a delivery that fails after redaction (SSRF
      // block, network error, non-2xx) must not defeat AC5 by landing
      // unredacted pii/financial values in this record.
      await withTenantContext(tenantId, (tx) =>
        tx.insert(deadLetterEvents).values({
          tenantId,
          eventType: `connector.${eventType}`,
          payload: {
            connectorId,
            actionId,
            deliveryId,
            targetUrl,
            payload: payloadForDeadLetter,
          },
          error: message,
          attemptCount: attemptNumber,
        }),
      );
      logger.error(
        { tenantId, connectorId, deliveryId, attemptNumber, err: message },
        "connector-outbound: delivery exhausted — dead-lettered",
      );
    } else {
      // BullMQ's own exponential backoff computes the actual retry delay;
      // this column is an operator-facing approximation of the same
      // schedule (connectorOutboundQueue's documented delay * 2^i formula),
      // not the authoritative scheduling source.
      const backoffMs = 45_000 * Math.pow(2, Math.max(attemptNumber - 1, 0));
      await finalizeAttempt(tenantId, attemptRowId, {
        status: "failed",
        latencyMs,
        error: message,
        nextRetryAt: new Date(Date.now() + backoffMs),
      });
      logger.warn(
        { tenantId, connectorId, deliveryId, attemptNumber, err: message },
        "connector-outbound: delivery attempt failed — will retry",
      );
    }

    // Rethrow so BullMQ records this attempt as failed and schedules the
    // next retry per connectorOutboundQueue's backoff config.
    throw err;
  }
}

export const connectorOutboundWorker = new Worker<ConnectorOutboundJobData>(
  QUEUE_NAME,
  processJob,
  { connection },
);

connectorOutboundWorker.on("failed", (job, err) => {
  logger.error(
    {
      jobId: job?.id,
      tenantId: job?.data.tenantId,
      connectorId: job?.data.connectorId,
      err: String(err),
      attemptsMade: job?.attemptsMade,
    },
    "connector-outbound: job failed",
  );
});

export function stopConnectorOutboundWorker(): Promise<void> {
  return connectorOutboundWorker.close();
}
