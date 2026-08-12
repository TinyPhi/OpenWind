/**
 * Unit tests for outbound-envelope.ts (issue #365, ADR-009 Decisions #9/#10).
 * Pure functions — no I/O, no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  OUTBOUND_ENVELOPE_VERSION,
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_DELIVERY_ID_HEADER,
  buildOutboundEnvelope,
  signOutboundPayload,
  buildSignatureHeaderValue,
  signOutboundRequest,
  verifyOutboundSignature,
  validateActionOutput,
} from "./outbound-envelope.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./types.js";

describe("buildOutboundEnvelope", () => {
  it("includes the version field (restores architecture-brief.md §6.2's commitment)", () => {
    const envelope = buildOutboundEnvelope({
      deliveryId: "d1",
      eventType: "ticket.created",
      tenantId: "tenant-1",
      connectorId: "connector-1",
      data: { foo: "bar" },
    });
    expect(envelope.version).toBe(OUTBOUND_ENVELOPE_VERSION);
    expect(envelope.deliveryId).toBe("d1");
    expect(envelope.eventType).toBe("ticket.created");
    expect(envelope.tenantId).toBe("tenant-1");
    expect(envelope.connectorId).toBe("connector-1");
    expect(envelope.data).toEqual({ foo: "bar" });
    expect(() => new Date(envelope.timestamp).toISOString()).not.toThrow();
  });

  it("uses the injected `now` when provided (test determinism)", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const envelope = buildOutboundEnvelope({
      deliveryId: "d1",
      eventType: "e",
      tenantId: "t",
      connectorId: "c",
      data: {},
      now: fixed,
    });
    expect(envelope.timestamp).toBe(fixed.toISOString());
  });
});

describe("signOutboundPayload / verifyOutboundSignature", () => {
  it("produces a deterministic signature for the same secret/deliveryId/timestamp/body", () => {
    const sig1 = signOutboundPayload("secret", "d1", 1000, "body");
    const sig2 = signOutboundPayload("secret", "d1", 1000, "body");
    expect(sig1).toBe(sig2);
  });

  it("produces a different signature for a different secret, deliveryId, timestamp, or body", () => {
    const base = signOutboundPayload("secret", "d1", 1000, "body");
    expect(signOutboundPayload("other-secret", "d1", 1000, "body")).not.toBe(
      base,
    );
    expect(signOutboundPayload("secret", "d2", 1000, "body")).not.toBe(base);
    expect(signOutboundPayload("secret", "d1", 2000, "body")).not.toBe(base);
    expect(signOutboundPayload("secret", "d1", 1000, "other-body")).not.toBe(
      base,
    );
  });

  it("verifyOutboundSignature accepts a signature it produced and rejects a tampered one", () => {
    const sig = signOutboundPayload("secret", "d1", 1000, "body");
    expect(verifyOutboundSignature("secret", "d1", "body", 1000, sig)).toBe(
      true,
    );
    expect(
      verifyOutboundSignature("secret", "d1", "tampered-body", 1000, sig),
    ).toBe(false);
    expect(
      verifyOutboundSignature("wrong-secret", "d1", "body", 1000, sig),
    ).toBe(false);
  });

  it("rejects the same signature relabeled with a different deliveryId (replay-dedupe bypass regression)", () => {
    const sig = signOutboundPayload("secret", "d1", 1000, "body");
    expect(verifyOutboundSignature("secret", "d2", "body", 1000, sig)).toBe(
      false,
    );
  });

  it("buildSignatureHeaderValue matches the documented t=...,v1=... format", () => {
    expect(buildSignatureHeaderValue(1000, "abcd")).toBe("t=1000,v1=abcd");
  });

  it("signOutboundRequest attaches both required headers, signature bound to the deliveryId", () => {
    const headers = signOutboundRequest("secret", "body", "delivery-123", 1000);
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBe(
      `t=1000,v1=${signOutboundPayload("secret", "delivery-123", 1000, "body")}`,
    );
    expect(headers[OUTBOUND_DELIVERY_ID_HEADER]).toBe("delivery-123");
  });
});

describe("validateActionOutput", () => {
  const action = {
    output: z.object({ amount: z.number(), label: z.string() }),
  };

  it("accepts a payload matching the declared schema and under the size limit", () => {
    const result = validateActionOutput(action, {
      amount: 42,
      label: "ok",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ amount: 42, label: "ok" });
      expect(result.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("rejects a payload that fails schema validation", () => {
    const result = validateActionOutput(action, { amount: "not-a-number" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/schema validation/);
    }
  });

  it("rejects a payload exceeding the default max size", () => {
    const hugeLabel = "x".repeat(DEFAULT_MAX_OUTPUT_BYTES + 1);
    const result = validateActionOutput(action, {
      amount: 1,
      label: hugeLabel,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exceeds max/);
    }
  });

  it("honors a per-action maxOutputBytes override smaller than the default", () => {
    const smallAction = {
      output: z.object({ label: z.string() }),
      maxOutputBytes: 16,
    };
    const result = validateActionOutput(smallAction, {
      label: "this is definitely more than sixteen bytes",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exceeds max 16 bytes/);
    }
  });

  it("checks size BEFORE schema — an oversized payload is rejected for size even if also schema-invalid", () => {
    const smallAction = {
      output: z.object({ amount: z.number() }),
      maxOutputBytes: 8,
    };
    const result = validateActionOutput(smallAction, {
      amount: "wrong-type-and-also-way-too-long-for-the-limit",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/exceeds max/);
    }
  });
});
