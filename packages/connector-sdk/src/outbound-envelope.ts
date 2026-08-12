/**
 * outbound-envelope.ts
 *
 * Pure helpers for ADR-009 Decision #9/#10's connector outbound delivery
 * mechanism (issue #365): envelope construction, HMAC signing, and the
 * schema/size validation gate. No I/O, no DB, no BullMQ — kept dependency-free
 * like ssrf-guard.ts so apps/worker's connector-outbound-worker.ts (the actual
 * queue consumer) can unit-test the signing/validation math without a real
 * Postgres or Redis connection.
 *
 * Header scheme (documented here for future reconciliation with issue #364's
 * inbound webhook gateway, which was not yet implemented as of this issue —
 * see PROGRESS.md): mirrors ADR-009 Decision #3's inbound scheme so the
 * platform has one signing convention, not two:
 *   - X-OpenWind-Signature: "t=<unix_seconds>,v1=<hex hmac-sha256>"
 *       signature = HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *       (Stripe/Svix precedent, matching ADR-009 Decision #3's inbound spec)
 *   - X-OpenWind-Delivery-Id: "<uuid>" — stable across every retry attempt of
 *     the same logical delivery (mirrors svix-id), lets the receiver dedupe.
 * `timestamp` is regenerated fresh on every delivery ATTEMPT (it is the send
 * time, not the original-event time — the receiver's tolerance-window check
 * needs to compare against when the request was actually sent); `deliveryId`
 * is generated once per logical delivery and reused across retries.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDefinition } from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./types.js";

export const OUTBOUND_ENVELOPE_VERSION = 1;
export const OUTBOUND_SIGNATURE_HEADER = "X-OpenWind-Signature";
export const OUTBOUND_DELIVERY_ID_HEADER = "X-OpenWind-Delivery-Id";

export interface OutboundEnvelope {
  /** Restores architecture-brief.md §6.2's event-schema-versioning commitment (ADR-009 Decision #9). */
  version: number;
  deliveryId: string;
  eventType: string;
  tenantId: string;
  connectorId: string;
  /** ISO 8601 — the time this specific delivery ATTEMPT was sent, not the original event time. */
  timestamp: string;
  data: unknown;
}

export function buildOutboundEnvelope(params: {
  deliveryId: string;
  eventType: string;
  tenantId: string;
  connectorId: string;
  data: unknown;
  now?: Date;
}): OutboundEnvelope {
  return {
    version: OUTBOUND_ENVELOPE_VERSION,
    deliveryId: params.deliveryId,
    eventType: params.eventType,
    tenantId: params.tenantId,
    connectorId: params.connectorId,
    timestamp: (params.now ?? new Date()).toISOString(),
    data: params.data,
  };
}

/**
 * HMAC-SHA256 over `${deliveryId}.${timestampUnixSeconds}.${rawBody}` — same
 * construction as ADR-009 Decision #3's inbound verification, so the platform
 * has exactly one signing convention shared by both directions.
 *
 * deliveryId is part of the SIGNED content, not just a sibling header —
 * matching Svix's own `msgId.timestamp.payload` precedent this scheme is
 * otherwise modeled on. Security review of issue #364 (the inbound verifier)
 * caught that an earlier version signed only `timestamp.rawBody`: since the
 * inbound gateway's replay-dedupe keys solely on the (unsigned) delivery-id
 * header, an attacker who captured one valid (signature, timestamp, body)
 * triple could relabel it with a fresh delivery-id and bypass replay
 * protection entirely — the signature stayed valid because it never covered
 * the id. Binding deliveryId into the signature closes that gap.
 */
export function signOutboundPayload(
  secret: string,
  deliveryId: string,
  timestampUnixSeconds: number,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${deliveryId}.${timestampUnixSeconds}.${rawBody}`)
    .digest("hex");
}

export function buildSignatureHeaderValue(
  timestampUnixSeconds: number,
  signatureHex: string,
): string {
  return `t=${timestampUnixSeconds},v1=${signatureHex}`;
}

/**
 * Signs `rawBody` and returns the two headers a delivery attempt must send.
 * `timestampUnixSeconds` defaults to "now" but is accepted as a parameter so
 * tests can pin it.
 */
export function signOutboundRequest(
  secret: string,
  rawBody: string,
  deliveryId: string,
  timestampUnixSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const signature = signOutboundPayload(
    secret,
    deliveryId,
    timestampUnixSeconds,
    rawBody,
  );
  return {
    [OUTBOUND_SIGNATURE_HEADER]: buildSignatureHeaderValue(
      timestampUnixSeconds,
      signature,
    ),
    [OUTBOUND_DELIVERY_ID_HEADER]: deliveryId,
  };
}

/**
 * Constant-time comparison helper — exported so any future consumer that
 * needs to verify one of these signatures (e.g. a test harness standing in
 * for a connector's receiving endpoint, or issue #364's inbound gateway)
 * does not reach for `===` on secret material. Not used by the outbound
 * sender itself (which only signs). `deliveryId` MUST be the value the
 * caller will use for its own replay-dedupe key — passing a different value
 * than what's actually dedupe-checked reopens the bypass this binding fixes.
 */
export function verifyOutboundSignature(
  secret: string,
  deliveryId: string,
  rawBody: string,
  timestampUnixSeconds: number,
  signatureHex: string,
): boolean {
  const expected = signOutboundPayload(
    secret,
    deliveryId,
    timestampUnixSeconds,
    rawBody,
  );
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type PayloadValidationResult =
  | { ok: true; data: unknown; sizeBytes: number }
  | { ok: false; reason: string };

/**
 * AC6 / ADR-009 Decision #10's integrity+DoS control — distinct from and in
 * addition to the confidentiality control the sensitivity redactor provides.
 * Enforced at the delivery boundary (called by connector-outbound-worker.ts
 * immediately before every attempt), not just relying on the TypeScript type
 * of ActionDefinition.output.
 *
 * Size is checked BEFORE schema parsing — cheaper, and avoids doing
 * zod validation work against an arbitrarily large candidate payload.
 */
export function validateActionOutput(
  action: Pick<ActionDefinition, "output" | "maxOutputBytes">,
  candidate: unknown,
): PayloadValidationResult {
  const maxBytes = action.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  // JSON.stringify(undefined) returns `undefined` (not a string) — the only
  // case its declared return type doesn't cover for an `unknown` input.
  // "null" is the correct stand-in: it's what `undefined` becomes when
  // nested inside the envelope object that actually gets sent.
  const serialized =
    candidate === undefined ? "null" : JSON.stringify(candidate);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  if (sizeBytes > maxBytes) {
    return {
      ok: false,
      reason: `payload size ${sizeBytes} bytes exceeds max ${maxBytes} bytes`,
    };
  }

  const parsed = action.output.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `payload failed schema validation: ${parsed.error.message}`,
    };
  }

  return { ok: true, data: parsed.data, sizeBytes };
}
