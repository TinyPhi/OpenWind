/**
 * connector-outbound-worker.test.ts
 *
 * Unit tests for the connector outbound delivery mechanism (issue #365,
 * ADR-009 Decisions #9/#10). DB, bullmq, node:http(s), OpenBao decrypt, and
 * SSRF are all mocked — no real Postgres/Redis/network I/O (isolation tests
 * for the RLS-visible behavior of connector_delivery_attempts itself live
 * separately in apps/api/tests/isolation/, using a real Postgres database
 * per this repo's testing-conventions.md).
 *
 * Signing/envelope/validation (outbound-envelope.ts) are used for REAL here
 * (pure, already unit-tested in packages/connector-sdk) — these tests focus
 * on THIS file's own orchestration: attempt-row lifecycle (pending -> a
 * terminal status), fail-closed registry lookup, validate-then-redact
 * ordering, mandatory per-attempt SSRF, dead-lettering on exhaustion, and
 * connection pinning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { ConnectorDefinition } from "@platform/connector-sdk";
import type * as ConnectorSdk from "@platform/connector-sdk";

// ── bullmq ───────────────────────────────────────────────────────────────────

type ProcessorFn = (job: {
  id: string;
  data: Record<string, unknown>;
  attemptsMade: number;
  opts: { attempts?: number };
}) => Promise<void>;

let capturedProcessor: ProcessorFn | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: ProcessorFn,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("./queues.js", () => ({
  connection: {},
  connectorOutboundQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

// ── @platform/db ─────────────────────────────────────────────────────────────

let insertedAttemptId: string;
let insertReturningResult: Array<{ id: string }>;
let entityFieldRows: Array<{ name: string; sensitivity: string }>;

const mockInsertReturning = vi.fn(() => Promise.resolve(insertReturningResult));
const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
const mockInsertConnectorAttempts = vi.fn(() => ({ values: mockInsertValues }));

const mockUpdateWhere = vi.fn(() => Promise.resolve(undefined));
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdateConnectorAttempts = vi.fn(() => ({ set: mockUpdateSet }));

const mockDeadLetterValues = vi.fn().mockResolvedValue(undefined);
const mockDeadLetterInsert = vi.fn(() => ({ values: mockDeadLetterValues }));

// Distinct object identities so tx.insert(table) can route to the right mock
// below — the dead-letter write now runs through withTenantContext's `tx`
// (issue #365 security-review fix), same as the connector_delivery_attempts
// writes, so a single tx.insert mock must distinguish which table it's for.
const mockConnectorDeliveryAttemptsTable = { id: "id", tenantId: "tenantId" };
const mockDeadLetterEventsTable = {};

const tx = {
  insert: (table: unknown) =>
    table === mockDeadLetterEventsTable
      ? mockDeadLetterInsert()
      : mockInsertConnectorAttempts(),
  update: (..._args: unknown[]) => mockUpdateConnectorAttempts(),
};

const mockSelectWhere = vi.fn(() => Promise.resolve(entityFieldRows));
const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));

const mockIsTenantActive = vi.fn().mockResolvedValue(true);

vi.mock("@platform/db", () => ({
  db: { select: mockSelect },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(tx),
  entityFields: {
    name: "name",
    sensitivity: "sensitivity",
    entityTypeId: "entityTypeId",
    tenantId: "tenantId",
  },
  connectorDeliveryAttempts: mockConnectorDeliveryAttemptsTable,
  deadLetterEvents: mockDeadLetterEventsTable,
  isTenantActive: (...args: unknown[]) => mockIsTenantActive(...args),
}));

// ── @platform/workflow-engine (faithful stand-in — real logic is tested in that package) ──

vi.mock("@platform/workflow-engine", () => ({
  buildSensitivityMap: (
    fields: ReadonlyArray<{ name: string; sensitivity: string }>,
  ) => {
    const map = new Map<string, string>();
    for (const f of fields) {
      if (f.sensitivity === "pii" || f.sensitivity === "financial") {
        map.set(f.name, f.sensitivity);
      }
    }
    return map;
  },
  redactMetadata: (
    metadata: Record<string, unknown>,
    sensitivityMap: Map<string, string>,
  ) => {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      redacted[key] = sensitivityMap.has(key) ? "[REDACTED]" : value;
    }
    return redacted;
  },
}));

// ── @platform/secrets ────────────────────────────────────────────────────────

const mockDecryptCredential = vi.fn().mockResolvedValue("signing-secret");
vi.mock("@platform/secrets", () => ({
  decryptCredential: (...args: unknown[]) => mockDecryptCredential(...args),
}));

// ── @platform/logger ─────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── @platform/connector-sdk: real signing/envelope/validation/registry, mocked SSRF ──

const mockAssertEgressAllowed = vi.fn().mockResolvedValue("93.184.216.34");
vi.mock("@platform/connector-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectorSdk>();
  return {
    ...actual,
    assertEgressAllowed: (...args: unknown[]) =>
      mockAssertEgressAllowed(...args),
  };
});

// ── node:http / node:https ───────────────────────────────────────────────────

type LookupCallback = (
  err: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;
type LookupFn = (
  host: string,
  opts: { all?: boolean },
  cb: LookupCallback,
) => void;

let capturedLookupFn: LookupFn | undefined;
let capturedRequestOptions: Record<string, unknown> | undefined;
let capturedRequestBody = "";
let responseStatus = 200;

function buildFakeReq(onResponse: () => void) {
  const req = {
    on: vi.fn(() => req),
    write: vi.fn((chunk: string) => {
      capturedRequestBody += chunk;
      return true;
    }),
    end: vi.fn(() => {
      onResponse();
      return req;
    }),
  };
  return req;
}

vi.mock("node:https", () => ({
  Agent: vi.fn().mockImplementation(function (opts: { lookup?: LookupFn }) {
    capturedLookupFn = opts.lookup;
  }),
  request: vi.fn(
    (opts: Record<string, unknown>, cb: (res: unknown) => void) => {
      capturedRequestOptions = opts;
      return buildFakeReq(() => {
        const res = {
          statusCode: responseStatus,
          on: (event: string, handler: (...a: unknown[]) => void) => {
            if (event === "end") handler();
          },
          resume: vi.fn(),
        };
        cb(res);
      });
    },
  ),
}));

vi.mock("node:http", () => ({
  Agent: vi.fn().mockImplementation(function (opts: { lookup?: LookupFn }) {
    capturedLookupFn = opts.lookup;
  }),
  request: vi.fn(
    (opts: Record<string, unknown>, cb: (res: unknown) => void) => {
      capturedRequestOptions = opts;
      return buildFakeReq(() => {
        const res = {
          statusCode: responseStatus,
          on: (event: string, handler: (...a: unknown[]) => void) => {
            if (event === "end") handler();
          },
          resume: vi.fn(),
        };
        cb(res);
      });
    },
  ),
}));

const { registerConnector, __resetConnectorRegistryForTests } =
  await import("@platform/connector-sdk");
await import("./connector-outbound-worker.js");

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CONNECTOR_ID = "connector-1";
const ACTION_ID = "send-webhook";

function registerTestConnector(): void {
  const definition: ConnectorDefinition = {
    meta: {
      id: CONNECTOR_ID,
      name: "Test Connector",
      version: "1.0.0",
      description: "test",
      iconUrl: "https://example.com/icon.png",
      category: "other",
    },
    allowedHosts: ["example.com"],
    auth: { type: "apiKey", headerName: "X-Api-Key", credentialKey: "k" },
    triggers: [],
    actions: [
      {
        id: ACTION_ID,
        name: "Send webhook",
        description: "test action",
        input: z.object({}),
        output: z.object({
          amount: z.number(),
          email: z.string(),
        }),
        execute: async () => ({}),
      },
    ],
  };
  registerConnector(definition);
}

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    attemptsMade: 0,
    opts: { attempts: 11 },
    data: {
      tenantId: "tenant-1",
      connectorId: CONNECTOR_ID,
      actionId: ACTION_ID,
      targetUrl: "https://example.com/webhook",
      eventType: "ticket.created",
      payload: { amount: 42, email: "user@example.com" },
      signingSecretCiphertext: "ciphertext",
      deliveryId: "delivery-1",
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetConnectorRegistryForTests();
  insertedAttemptId = "attempt-row-1";
  insertReturningResult = [{ id: insertedAttemptId }];
  entityFieldRows = [];
  capturedLookupFn = undefined;
  capturedRequestOptions = undefined;
  capturedRequestBody = "";
  responseStatus = 200;
  mockAssertEgressAllowed.mockResolvedValue("93.184.216.34");
  mockDecryptCredential.mockResolvedValue("signing-secret");
  mockIsTenantActive.mockResolvedValue(true);
});

describe("connector-outbound-worker: happy path", () => {
  it("inserts a pending attempt row, then finalizes it as success", async () => {
    registerTestConnector();

    await capturedProcessor!(baseJob());

    expect(mockInsertConnectorAttempts).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        connectorId: CONNECTOR_ID,
        deliveryId: "delivery-1",
        status: "pending",
        attemptNumber: 1,
      }),
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success" }),
    );
  });

  it("signs the envelope and attaches the delivery-id + signature headers", async () => {
    registerTestConnector();

    await capturedProcessor!(baseJob());

    const headers = capturedRequestOptions?.["headers"] as Record<
      string,
      string
    >;
    expect(headers["X-OpenWind-Delivery-Id"]).toBe("delivery-1");
    expect(headers["X-OpenWind-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const sentBody = JSON.parse(capturedRequestBody) as {
      version: number;
      deliveryId: string;
      eventType: string;
      data: Record<string, unknown>;
    };
    expect(sentBody.version).toBe(1);
    expect(sentBody.deliveryId).toBe("delivery-1");
    expect(sentBody.eventType).toBe("ticket.created");
  });

  it("pins the outbound connection to assertEgressAllowed's returned IP", async () => {
    registerTestConnector();
    mockAssertEgressAllowed.mockResolvedValue("203.0.113.9");

    await capturedProcessor!(baseJob());

    expect(capturedLookupFn).toBeDefined();
    let capturedAddress: unknown;
    capturedLookupFn!("example.com", {}, (_err, address) => {
      capturedAddress = address;
    });
    expect(capturedAddress).toBe("203.0.113.9");
  });

  it("redacts pii/financial fields before signing/sending (AC5)", async () => {
    registerTestConnector();
    entityFieldRows = [
      { name: "email", sensitivity: "pii" },
      { name: "amount", sensitivity: "internal" },
    ];

    await capturedProcessor!(baseJob({ entityTypeId: "entity-type-1" }));

    const sentBody = JSON.parse(capturedRequestBody) as {
      data: Record<string, unknown>;
    };
    expect(sentBody.data["email"]).toBe("[REDACTED]");
    expect(sentBody.data["amount"]).toBe(42);
  });

  it("does not redact anything when no entityTypeId is given", async () => {
    registerTestConnector();

    await capturedProcessor!(baseJob());

    const sentBody = JSON.parse(capturedRequestBody) as {
      data: Record<string, unknown>;
    };
    expect(sentBody.data["email"]).toBe("user@example.com");
  });
});

describe("connector-outbound-worker: fail-closed registry lookup", () => {
  it("fails the attempt when the connector is not registered", async () => {
    await expect(capturedProcessor!(baseJob())).rejects.toThrow(
      /not registered/,
    );

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(mockAssertEgressAllowed).not.toHaveBeenCalled();
  });

  it("fails the attempt when the action id does not exist on the connector", async () => {
    registerTestConnector();

    await expect(
      capturedProcessor!(baseJob({ actionId: "does-not-exist" })),
    ).rejects.toThrow(/has no action/);
  });
});

describe("connector-outbound-worker: AC6 payload validation", () => {
  it("rejects a payload that fails the action's declared output schema before any network call", async () => {
    registerTestConnector();

    await expect(
      capturedProcessor!(
        baseJob({
          payload: { amount: "not-a-number", email: "x@example.com" },
        }),
      ),
    ).rejects.toThrow(/payload validation failed/);

    expect(mockAssertEgressAllowed).not.toHaveBeenCalled();
  });

  it("rejects an oversized payload before any network call", async () => {
    registerTestConnector();

    await expect(
      capturedProcessor!(
        baseJob({
          payload: { amount: 1, email: "x".repeat(300_000) },
        }),
      ),
    ).rejects.toThrow(/payload validation failed/);

    expect(mockAssertEgressAllowed).not.toHaveBeenCalled();
  });
});

describe("connector-outbound-worker: AC4 mandatory per-attempt SSRF", () => {
  it("fails the attempt when assertEgressAllowed rejects, without ever decrypting the signing secret", async () => {
    registerTestConnector();
    mockAssertEgressAllowed.mockRejectedValue(
      new Error("Connector egress blocked: private range"),
    );

    await expect(capturedProcessor!(baseJob())).rejects.toThrow(
      /egress blocked/,
    );
    expect(mockDecryptCredential).not.toHaveBeenCalled();
  });

  it("re-validates SSRF on every attempt, not just the first", async () => {
    registerTestConnector();

    await capturedProcessor!(baseJob({}));
    await capturedProcessor!(baseJob({}));

    expect(mockAssertEgressAllowed).toHaveBeenCalledTimes(2);
  });
});

describe("connector-outbound-worker: retry vs exhaustion", () => {
  it("marks a non-final failed attempt as 'failed' with a next_retry_at, and does not dead-letter", async () => {
    // No registerTestConnector() call — the registry lookup fails, giving a
    // deterministic failure to exercise the non-final-attempt path.
    await expect(capturedProcessor!(baseJob())).rejects.toThrow();

    // attemptsMade: 0 means this is attempt 1 of 11 — not the last attempt.
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    const call = mockUpdateSet.mock.calls[0]?.[0] as { nextRetryAt: Date };
    expect(call.nextRetryAt).toBeInstanceOf(Date);
    expect(mockDeadLetterInsert).not.toHaveBeenCalled();
  });

  it("marks the final attempt as 'exhausted' and writes a dead_letter_events row", async () => {
    const job = baseJob();
    job.attemptsMade = 10; // attempt 11 of 11 (opts.attempts = 11) — the last one.

    await expect(capturedProcessor!(job)).rejects.toThrow();

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "exhausted" }),
    );
    expect(mockDeadLetterInsert).toHaveBeenCalledTimes(1);
    expect(mockDeadLetterValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        eventType: "connector.ticket.created",
        attemptCount: 11,
      }),
    );
  });

  it("dead-letters the REDACTED payload, not the raw one, when exhaustion happens after redaction ran (security-review fix)", async () => {
    registerTestConnector();
    entityFieldRows = [{ name: "email", sensitivity: "pii" }];
    responseStatus = 500; // non-2xx — fails at the deliver() step, i.e. AFTER Step 4 (redact) ran

    const job = baseJob({ entityTypeId: "entity-type-1" });
    job.attemptsMade = 10; // last attempt

    await expect(capturedProcessor!(job)).rejects.toThrow(/non-2xx/);

    expect(mockDeadLetterInsert).toHaveBeenCalledTimes(1);
    const call = mockDeadLetterValues.mock.calls[0]?.[0] as {
      payload: { payload: Record<string, unknown> };
    };
    expect(call.payload.payload["email"]).toBe("[REDACTED]");
    expect(call.payload.payload["amount"]).toBe(42);
  });

  it("dead-letters withTenantContext (RLS-scoped), not a bare superuser insert", async () => {
    const job = baseJob();
    job.attemptsMade = 10;

    await expect(capturedProcessor!(job)).rejects.toThrow();

    // tx.insert is only reachable via the withTenantContext(tenantId, fn) mock
    // above — reaching mockDeadLetterInsert at all proves the write went
    // through tenant context, not a plain top-level db.insert.
    expect(mockDeadLetterInsert).toHaveBeenCalledTimes(1);
  });
});

describe("connector-outbound-worker: inactive tenant guard", () => {
  it("does nothing when the tenant is not active", async () => {
    mockIsTenantActive.mockResolvedValue(false);

    await capturedProcessor!(baseJob());

    expect(mockInsertConnectorAttempts).not.toHaveBeenCalled();
    expect(mockAssertEgressAllowed).not.toHaveBeenCalled();
  });
});

describe("connector-outbound-worker: non-2xx response", () => {
  it("fails the attempt on a non-2xx response", async () => {
    registerTestConnector();
    responseStatus = 500;

    await expect(capturedProcessor!(baseJob())).rejects.toThrow(/non-2xx/);
  });
});
