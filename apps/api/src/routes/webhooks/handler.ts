/**
 * POST /webhooks/:connectorId/:tenantId — inbound connector webhook gateway
 * (ADR-009 Decision #3, issue #364).
 *
 * Deliberately unauthenticated by JWT/API-key — the HMAC signature IS the
 * authentication. Reuses @platform/connector-sdk's outbound-envelope helpers
 * (built for issue #365's opposite direction) rather than reimplementing HMAC
 * verification or inventing different header names — verifyOutboundSignature's
 * construction (HMAC-SHA256 over `${timestamp}.${rawBody}`) is exactly ADR-009
 * Decision #3's inbound spec too, so the platform now has ONE signing
 * convention shared by both directions (resolves #365's own "pending
 * reconciliation" note).
 *
 * Order of operations, each a distinct rejection reason internally but
 * collapsed to the SAME 401 response for AC4's "no existence oracle" — an
 * attacker probing this endpoint cannot tell "wrong tenant/connector" apart
 * from "right tenant/connector, wrong signature":
 *   1. Parse + range-check the signature header's timestamp (±5min tolerance).
 *   2. Look up the (tenantId, connectorId) installation's signing secret.
 *   3. Verify the signature against the raw body.
 *   4. Replay-dedupe on the delivery-id header (fails CLOSED, not open —
 *      unlike rate-limit.ts's checkRateLimit: a captured-and-resent valid
 *      request is a security concern this dedupe exists specifically to
 *      catch, so a Redis outage should block delivery, not silently disable
 *      the check. A legitimate sender's retry-on-no-response behavior means
 *      failing closed here just delays processing, not loses it).
 * Only after all four pass does AC5's registry lookup + trigger transform run
 * (a *different* failure class from AC4 — the caller already authenticated
 * successfully at that point).
 */
import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import {
  connectorCredentials,
  connectorInstallationFilter,
  withTenantContext,
} from "@platform/db";
import { decryptCredential } from "@platform/secrets";
import {
  getConnectorDefinition,
  verifyOutboundSignature,
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_DELIVERY_ID_HEADER,
} from "@platform/connector-sdk";
import { logger } from "@platform/logger";
import { connection as redis } from "../../lib/redis.js";
import { connectorInboundQueue } from "../../lib/connector-inbound-queue.js";
import { factory } from "./factory.js";

const ParamsSchema = z.object({
  connectorId: z.string().uuid(),
  tenantId: z.string().uuid(),
});

// Same tolerance window Stripe/Svix use, cited in ADR-009 Decision #3.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
// Well-known credentialKey a connector's inbound-webhook shared secret is
// stored under in connector_credentials.secrets (a JSONB credentialKey ->
// ciphertext map, per #363's ConnectorAuthConfig shape) — distinct from any
// outbound-API-auth credentialKey the same installation might also carry.
const WEBHOOK_SIGNING_SECRET_KEY = "webhookSigningSecret";
// Not a real ciphertext — used only to give the "no installation found"
// branch an OpenBao round-trip of the same shape as the real decrypt call,
// for AC4 timing equalization (see the call site). OpenBao will reject it;
// the error is caught and discarded.
const DUMMY_CIPHERTEXT_FOR_TIMING = "vault:v1:timing-equalization-placeholder";

const GENERIC_AUTH_FAILURE = {
  error: "UNAUTHORIZED",
  message: "Invalid or missing webhook signature",
} as const;

function parseSignatureHeader(
  value: string | undefined,
): { timestamp: number; signatureHex: string } | undefined {
  if (!value) return undefined;
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(value);
  if (!match) return undefined;
  const timestamp = Number(match[1]);
  const signatureHex = match[2];
  if (!Number.isFinite(timestamp) || !signatureHex) return undefined;
  return { timestamp, signatureHex };
}

export const webhookGatewayHandler = factory.createHandlers(
  zValidator("param", ParamsSchema),
  async (c) => {
    const { connectorId, tenantId } = c.req.valid("param");
    const rawBody = await c.req.text();

    const parsedSig = parseSignatureHeader(
      c.req.header(OUTBOUND_SIGNATURE_HEADER),
    );
    const deliveryId = c.req.header(OUTBOUND_DELIVERY_ID_HEADER);

    if (!parsedSig || !deliveryId) {
      return c.json(GENERIC_AUTH_FAILURE, 401);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      Math.abs(nowSeconds - parsedSig.timestamp) > TIMESTAMP_TOLERANCE_SECONDS
    ) {
      return c.json(GENERIC_AUTH_FAILURE, 401);
    }

    const [installation] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          secrets: connectorCredentials.secrets,
          disabledAt: connectorCredentials.disabledAt,
        })
        .from(connectorCredentials)
        .where(connectorInstallationFilter(tenantId, connectorId))
        .limit(1),
    );

    const secretCiphertext = (
      installation?.secrets as Record<string, string> | undefined
    )?.[WEBHOOK_SIGNING_SECRET_KEY];

    if (!installation || !secretCiphertext || installation.disabledAt) {
      // AC4 timing equalization (security review): the "installation found"
      // branch below always performs a real OpenBao decrypt round-trip
      // before it can return 401 on a bad signature. Returning immediately
      // here — skipping that network hop — would make "no such
      // tenant/connector" measurably faster than "found, wrong signature",
      // a timing side-channel that defeats the no-existence-oracle property
      // this route is otherwise built around. Pay an equivalent-shaped
      // dummy decrypt against a placeholder ciphertext (result discarded,
      // error ignored — it's not expected to succeed) so both branches cost
      // the same before responding. A disabled installation (issue #367's
      // kill switch) folds into this SAME branch deliberately — an attacker
      // must not be able to learn "this connector exists but is disabled"
      // any more than "this connector doesn't exist" or "wrong signature".
      await decryptCredential(tenantId, DUMMY_CIPHERTEXT_FOR_TIMING).catch(
        () => undefined,
      );
      return c.json(GENERIC_AUTH_FAILURE, 401);
    }

    const signingSecret = await decryptCredential(tenantId, secretCiphertext);

    const verified = verifyOutboundSignature(
      signingSecret,
      deliveryId,
      rawBody,
      parsedSig.timestamp,
      parsedSig.signatureHex,
    );
    if (!verified) {
      return c.json(GENERIC_AUTH_FAILURE, 401);
    }

    // Replay-dedupe — fails CLOSED (see module doc). Scoped to
    // (tenantId, connectorId, deliveryId): a delivery-id is only guaranteed
    // unique per-sender, not globally.
    const replayKey = `webhook:replay:${tenantId}:${connectorId}:${deliveryId}`;
    let replaySetOk: string | null;
    try {
      replaySetOk = await redis.set(
        replayKey,
        "1",
        "EX",
        TIMESTAMP_TOLERANCE_SECONDS,
        "NX",
      );
    } catch (err) {
      logger.error(
        { err, tenantId, connectorId, deliveryId },
        "webhook gateway: replay-dedupe check failed — failing closed",
      );
      return c.json(
        { error: "SERVICE_UNAVAILABLE", message: "Try again shortly" },
        503,
      );
    }
    if (replaySetOk === null) {
      return c.json(
        { error: "DUPLICATE_DELIVERY", message: "Delivery already processed" },
        409,
      );
    }

    // AC5 — resolve the connector's real definition. Distinct failure class
    // from AC4 above: the caller already authenticated successfully, so no
    // existence-oracle concern applies to what we return from here on.
    const definition = getConnectorDefinition(connectorId);
    if (!definition) {
      logger.warn(
        { connectorId, tenantId, deliveryId },
        "webhook gateway: connector authenticated but not registered in this process",
      );
      return c.json(GENERIC_AUTH_FAILURE, 401);
    }

    const webhookTrigger = definition.triggers.find(
      (t) => t.type === "webhook" && t.webhook,
    );
    if (!webhookTrigger?.webhook) {
      return c.json(
        {
          error: "UNSUPPORTED_TRIGGER",
          message: "Connector does not support inbound webhooks",
        },
        400,
      );
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "INVALID_JSON", message: "Malformed body" }, 400);
    }

    let event: Record<string, unknown>;
    try {
      event = await webhookTrigger.webhook.transform(parsedPayload);
    } catch (err) {
      logger.warn(
        { err, connectorId, tenantId, deliveryId },
        "webhook gateway: trigger transform rejected the payload",
      );
      return c.json(
        { error: "TRANSFORM_FAILED", message: "Payload rejected by connector" },
        400,
      );
    }

    await connectorInboundQueue.add(
      "connector.inbound",
      { tenantId, connectorId, deliveryId, event },
      // jobId = deliveryId: a second successful delivery of the same id
      // (e.g. this process restarted between the replay-dedupe SET and the
      // enqueue call) is deduplicated by BullMQ too, not just Redis above.
      { jobId: deliveryId },
    );

    return c.json({ data: { received: true } }, 202);
  },
);
