import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type * as ConnectorSdk from "@platform/connector-sdk";

// ── @platform/db ─────────────────────────────────────────────────────────────

let installationRow:
  | { secrets: Record<string, string>; disabledAt?: Date | null }
  | undefined;

const mockSelectLimit = vi.fn(() =>
  Promise.resolve(installationRow ? [installationRow] : []),
);
const mockSelectWhere = vi.fn(() => ({ limit: mockSelectLimit }));
const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockSelect = vi.fn(() => ({ from: mockSelectFrom }));
const tx = { select: (...args: unknown[]) => mockSelect(...args) };

vi.mock("@platform/db", () => ({
  connectorCredentials: {
    tenantId: "tenantId",
    connectorId: "connectorId",
    secrets: "secrets",
    disabledAt: "disabledAt",
  },
  connectorInstallationFilter: (tenantId: string, connectorId: string) => ({
    op: "connectorInstallationFilter",
    tenantId,
    connectorId,
  }),
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(tx),
}));

// ── @platform/secrets ────────────────────────────────────────────────────────

const mockDecryptCredential = vi.fn().mockResolvedValue("shared-secret");
vi.mock("@platform/secrets", () => ({
  decryptCredential: (...args: unknown[]) => mockDecryptCredential(...args),
}));

// ── @platform/logger ─────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── @platform/connector-sdk: real signing/verification, mocked registry ──────

const mockGetConnectorDefinition = vi.fn();
vi.mock("@platform/connector-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectorSdk>();
  return {
    ...actual,
    getConnectorDefinition: (...args: unknown[]) =>
      mockGetConnectorDefinition(...args),
  };
});

// ── ../../lib/redis.js ───────────────────────────────────────────────────────

const mockRedisSet = vi.fn().mockResolvedValue("OK");
vi.mock("../../lib/redis.js", () => ({
  connection: { set: (...args: unknown[]) => mockRedisSet(...args) },
}));

// ── ../../lib/connector-inbound-queue.js ────────────────────────────────────

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../../lib/connector-inbound-queue.js", () => ({
  connectorInboundQueue: { add: (...args: unknown[]) => mockQueueAdd(...args) },
}));

const {
  signOutboundRequest,
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_DELIVERY_ID_HEADER,
} = await import("@platform/connector-sdk");
const { webhooksRouter } = await import("./index.js");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = "aaaaaaaa-0000-4000-a000-000000000001";
const CONNECTOR_ID = "bbbbbbbb-0000-4000-b000-000000000002";
const DELIVERY_ID = "cccccccc-0000-4000-c000-000000000003";

function makeApp() {
  const app = new Hono();
  app.route("/webhooks", webhooksRouter);
  return app;
}

function makeConnectorDefinition(
  overrides: Partial<ConnectorSdk.ConnectorDefinition> = {},
) {
  return {
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
    triggers: [
      {
        id: "trigger-1",
        name: "Test Trigger",
        description: "test",
        type: "webhook" as const,
        webhook: {
          transform: (raw: unknown) =>
            Promise.resolve(raw as Record<string, unknown>),
        },
      },
    ],
    actions: [],
    ...overrides,
  } as unknown as ConnectorSdk.ConnectorDefinition;
}

async function sendWebhook(body: string, headers: Record<string, string> = {}) {
  const app = makeApp();
  return app.request(`/webhooks/${CONNECTOR_ID}/${TENANT_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

function validHeaders(rawBody: string, timestampUnixSeconds?: number) {
  return signOutboundRequest(
    "shared-secret",
    rawBody,
    DELIVERY_ID,
    timestampUnixSeconds,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installationRow = { secrets: { webhookSigningSecret: "ciphertext" } };
  mockDecryptCredential.mockResolvedValue("shared-secret");
  mockRedisSet.mockResolvedValue("OK");
  mockGetConnectorDefinition.mockReturnValue(makeConnectorDefinition());
});

describe("POST /webhooks/:connectorId/:tenantId — happy path", () => {
  it("accepts a validly-signed request and enqueues the transformed event", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await sendWebhook(body, validHeaders(body));

    expect(res.status).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "connector.inbound",
      expect.objectContaining({
        tenantId: TENANT_ID,
        connectorId: CONNECTOR_ID,
        deliveryId: DELIVERY_ID,
        event: { hello: "world" },
      }),
      { jobId: DELIVERY_ID },
    );
  });
});

describe("POST /webhooks/:connectorId/:tenantId — AC3 signature verification", () => {
  it("rejects a request missing both signature headers", async () => {
    const res = await sendWebhook(JSON.stringify({}));
    expect(res.status).toBe(401);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature with the same body as a missing one", async () => {
    const body = JSON.stringify({ a: 1 });
    const goodHeaders = validHeaders(body);
    const tamperedRes = await sendWebhook(body, {
      [OUTBOUND_SIGNATURE_HEADER]: goodHeaders[
        OUTBOUND_SIGNATURE_HEADER
      ]!.replace(/v1=[0-9a-f]+/, `v1=${"0".repeat(64)}`),
      [OUTBOUND_DELIVERY_ID_HEADER]: DELIVERY_ID,
    });
    const missingRes = await sendWebhook(body);

    expect(tamperedRes.status).toBe(401);
    expect(missingRes.status).toBe(401);
    expect(await tamperedRes.json()).toEqual(await missingRes.json());
  });

  it("rejects a timestamp outside the +/-5 minute tolerance window", async () => {
    const body = JSON.stringify({});
    const staleTimestamp = Math.floor(Date.now() / 1000) - 6 * 60;
    const res = await sendWebhook(body, validHeaders(body, staleTimestamp));
    expect(res.status).toBe(401);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/:connectorId/:tenantId — AC4 no existence oracle", () => {
  it("returns the identical 401 body for an unknown installation and a bad signature", async () => {
    const body = JSON.stringify({});
    installationRow = undefined;
    const unknownRes = await sendWebhook(body, validHeaders(body));

    installationRow = { secrets: { webhookSigningSecret: "ciphertext" } };
    const badSigRes = await sendWebhook(body, {
      [OUTBOUND_SIGNATURE_HEADER]: `t=${Math.floor(Date.now() / 1000)},v1=${"1".repeat(64)}`,
      [OUTBOUND_DELIVERY_ID_HEADER]: DELIVERY_ID,
    });

    expect(unknownRes.status).toBe(401);
    expect(badSigRes.status).toBe(401);
    expect(await unknownRes.json()).toEqual(await badSigRes.json());
  });

  it("returns 401 when the installation has no webhookSigningSecret configured", async () => {
    installationRow = { secrets: {} };
    const body = JSON.stringify({});
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(401);
  });

  it("returns the identical 401 body for a disabled installation and an unknown one (issue #367)", async () => {
    const body = JSON.stringify({});

    installationRow = undefined;
    const unknownRes = await sendWebhook(body, validHeaders(body));

    installationRow = {
      secrets: { webhookSigningSecret: "ciphertext" },
      disabledAt: new Date(),
    };
    const disabledRes = await sendWebhook(body, validHeaders(body));

    expect(unknownRes.status).toBe(401);
    expect(disabledRes.status).toBe(401);
    expect(await unknownRes.json()).toEqual(await disabledRes.json());
  });

  it("pays an equivalent decrypt round-trip for a disabled installation (timing equalization, issue #367)", async () => {
    installationRow = {
      secrets: { webhookSigningSecret: "ciphertext" },
      disabledAt: new Date(),
    };
    const body = JSON.stringify({});
    await sendWebhook(body, validHeaders(body));
    expect(mockDecryptCredential).toHaveBeenCalledTimes(1);
  });

  it("pays an equivalent decrypt round-trip when no installation is found (timing equalization, security review)", async () => {
    installationRow = undefined;
    const body = JSON.stringify({});
    await sendWebhook(body, validHeaders(body));
    // The "found, bad signature" branch always calls decryptCredential before
    // it can respond — this asserts the "not found" branch does too, so an
    // attacker can't distinguish the two paths by response latency.
    expect(mockDecryptCredential).toHaveBeenCalledTimes(1);
  });

  it("rejects a captured signature relabeled with a different delivery-id (replay-dedupe bypass regression)", async () => {
    const body = JSON.stringify({});
    const headers = validHeaders(body); // signed for DELIVERY_ID
    const relabeled = {
      ...headers,
      [OUTBOUND_DELIVERY_ID_HEADER]: "attacker-chosen-delivery-id",
    };
    const res = await sendWebhook(body, relabeled);
    expect(res.status).toBe(401);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/:connectorId/:tenantId — replay dedupe", () => {
  it("rejects a replayed delivery-id with 409, without touching the queue", async () => {
    mockRedisSet.mockResolvedValue(null); // NX found an existing key
    const body = JSON.stringify({});
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(409);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("fails CLOSED (503) when the replay-dedupe check itself errors", async () => {
    mockRedisSet.mockRejectedValue(new Error("redis down"));
    const body = JSON.stringify({});
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(503);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/:connectorId/:tenantId — AC5 trigger dispatch", () => {
  it("returns 401 when the connector authenticated but is not registered in this process", async () => {
    mockGetConnectorDefinition.mockReturnValue(undefined);
    const body = JSON.stringify({});
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(401);
  });

  it("returns 400 when the connector has no webhook trigger", async () => {
    mockGetConnectorDefinition.mockReturnValue(
      makeConnectorDefinition({ triggers: [] }),
    );
    const body = JSON.stringify({});
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON body", async () => {
    const body = "not json";
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the trigger's transform rejects the payload", async () => {
    mockGetConnectorDefinition.mockReturnValue(
      makeConnectorDefinition({
        triggers: [
          {
            id: "t1",
            name: "t",
            description: "t",
            type: "webhook" as const,
            webhook: {
              transform: () => Promise.reject(new Error("bad shape")),
            },
          },
        ],
      }),
    );
    const body = JSON.stringify({});
    const res = await sendWebhook(body, validHeaders(body));
    expect(res.status).toBe(400);
  });
});
