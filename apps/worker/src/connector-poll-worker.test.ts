/**
 * connector-poll-worker.test.ts
 *
 * Unit tests for the connector polling worker (issue #366, ADR-009
 * Decision #7). DB, bullmq, and queues.js are mocked — no real
 * Postgres/Redis I/O (RLS-visible behavior of connector_credentials.cursor_state
 * itself is covered separately by the isolation test suite per
 * testing-conventions.md). @platform/connector-sdk's real in-process registry
 * is used (registerConnector/__resetConnectorRegistryForTests), matching
 * connector-outbound-worker.test.ts's convention — only createConnectorContext
 * is mocked, since building a real ConnectorContext (credential decrypt, SSRF
 * guard) is already covered by connector-sdk's own test suite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectorDefinition } from "@platform/connector-sdk";
import type * as ConnectorSdk from "@platform/connector-sdk";

// ── bullmq ───────────────────────────────────────────────────────────────────

type PollJobData = { tenantId: string; connectorId: string };
type ProcessorFn = (job: { id: string; data: PollJobData }) => Promise<void>;

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

const mockConnectorInboundAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("./queues.js", () => ({
  connection: {},
  connectorInboundQueue: {
    add: (...args: unknown[]) => mockConnectorInboundAdd(...args),
  },
}));

// ── @platform/db ─────────────────────────────────────────────────────────────

let selectResult: Array<{
  secrets: Record<string, string>;
  cursorState: unknown;
  disabledAt?: Date | null;
}>;

const mockLimit = vi.fn(() => Promise.resolve(selectResult));
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

const mockUpdateWhere = vi.fn(() => Promise.resolve(undefined));
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

const tx = { select: mockSelect, update: mockUpdate };

const mockIsTenantActive = vi.fn().mockResolvedValue(true);

vi.mock("@platform/db", () => ({
  connectorCredentials: {
    tenantId: "tenantId",
    connectorId: "connectorId",
    secrets: "secrets",
    cursorState: "cursorState",
    disabledAt: "disabledAt",
  },
  connectorInstallationFilter: (tenantId: string, connectorId: string) => ({
    op: "connectorInstallationFilter",
    tenantId,
    connectorId,
  }),
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(tx),
  isTenantActive: (...args: unknown[]) => mockIsTenantActive(...args),
}));

// ── @platform/connector-sdk: real registry, mocked createConnectorContext ────

const mockCtx = { tenantId: "unused", callApi: vi.fn(), log: vi.fn() };
const mockCreateConnectorContext = vi.fn(() => mockCtx);
vi.mock("@platform/connector-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectorSdk>();
  return {
    ...actual,
    createConnectorContext: (...args: unknown[]) =>
      mockCreateConnectorContext(...args),
  };
});

// ── @platform/logger ─────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

const { registerConnector, __resetConnectorRegistryForTests } =
  await import("@platform/connector-sdk");
await import("./connector-poll-worker.js");

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";
const CONNECTOR_ID = "connector-1";

function registerPollingConnector(
  fetchImpl: ConnectorDefinition["triggers"][number]["polling"] extends {
    fetch: infer F;
  }
    ? F
    : never,
): void {
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
    triggers: [
      {
        id: "poll",
        name: "Poll",
        description: "test",
        type: "polling",
        polling: { intervalMinutes: 5, fetch: fetchImpl },
      },
    ],
    actions: [],
  };
  registerConnector(definition);
}

async function runJob(jobId = "bull-job-1"): Promise<void> {
  if (!capturedProcessor) throw new Error("processor not captured");
  await capturedProcessor({
    id: jobId,
    data: { tenantId: TENANT_ID, connectorId: CONNECTOR_ID },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("connector poll worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetConnectorRegistryForTests();
    mockIsTenantActive.mockResolvedValue(true);
    selectResult = [{ secrets: { k: "ciphertext" }, cursorState: null }];
  });

  it("enqueues events onto connectorInboundQueue and advances cursor_state", async () => {
    registerPollingConnector(async () => ({
      events: [{ subject: "a" }, { subject: "b" }],
      nextCursor: "42",
    }));

    await runJob();

    expect(mockConnectorInboundAdd).toHaveBeenCalledTimes(2);
    for (const call of mockConnectorInboundAdd.mock.calls) {
      const [name, data, opts] = call as [
        string,
        Record<string, unknown>,
        { jobId: string },
      ];
      expect(name).toBe("connector.inbound");
      expect(data.tenantId).toBe(TENANT_ID);
      expect(data.connectorId).toBe(CONNECTOR_ID);
      expect(data.deliveryId).toBe(opts.jobId);
    }
    // Two distinct events get two distinct deliveryIds.
    const ids = mockConnectorInboundAdd.mock.calls.map(
      (c) => (c[1] as Record<string, unknown>).deliveryId,
    );
    expect(new Set(ids).size).toBe(2);

    expect(mockUpdateSet).toHaveBeenCalledWith({
      cursorState: { cursor: "42" },
    });
  });

  it("does not advance cursor_state when fetch returns no nextCursor", async () => {
    registerPollingConnector(async () => ({ events: [] }));

    await runJob();

    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("passes the stored cursor into fetch()", async () => {
    selectResult = [{ secrets: {}, cursorState: { cursor: "cursor-7" } }];
    const fetchImpl = vi.fn().mockResolvedValue({ events: [{ x: 1 }] });
    registerPollingConnector(fetchImpl);

    await runJob();

    expect(fetchImpl).toHaveBeenCalledWith(mockCtx, "cursor-7");
  });

  it("derives the same deliveryId when BullMQ retries the same job (same job.id)", async () => {
    registerPollingConnector(async () => ({ events: [{ x: 1 }] }));

    await runJob("bull-job-42");
    const firstDeliveryId = (
      mockConnectorInboundAdd.mock.calls[0]?.[1] as Record<string, unknown>
    ).deliveryId;

    mockConnectorInboundAdd.mockClear();
    await runJob("bull-job-42"); // same BullMQ job id — simulates an attempts:3 retry
    const secondDeliveryId = (
      mockConnectorInboundAdd.mock.calls[0]?.[1] as Record<string, unknown>
    ).deliveryId;

    expect(firstDeliveryId).toBe(secondDeliveryId);
  });

  it("derives a different deliveryId for the next scheduled poll even when cursor_state didn't advance", async () => {
    // Regression guard: deriving deliveryId from cursor_state instead of the
    // BullMQ job's own id would make every poll cycle re-derive identical
    // ids whenever fetch() never returns a nextCursor, silently dropping new
    // events as BullMQ no-ops a duplicate-jobId add().
    registerPollingConnector(async () => ({ events: [{ x: 1 }] })); // never returns nextCursor

    await runJob("bull-job-1");
    const firstDeliveryId = (
      mockConnectorInboundAdd.mock.calls[0]?.[1] as Record<string, unknown>
    ).deliveryId;

    mockConnectorInboundAdd.mockClear();
    await runJob("bull-job-2"); // next scheduled occurrence, cursor_state unchanged
    const secondDeliveryId = (
      mockConnectorInboundAdd.mock.calls[0]?.[1] as Record<string, unknown>
    ).deliveryId;

    expect(firstDeliveryId).not.toBe(secondDeliveryId);
  });

  it("propagates a fetch() throw so BullMQ retries, without advancing cursor_state", async () => {
    registerPollingConnector(async () => {
      throw new Error("IMAP connection reset");
    });

    await expect(runJob()).rejects.toThrow("IMAP connection reset");
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws without enqueueing when fetch() returns a non-array events value", async () => {
    // @ts-expect-error deliberately violating the return type to test the runtime guard
    registerPollingConnector(async () => ({ events: "not-an-array" }));

    await expect(runJob()).rejects.toThrow(/non-array events/);
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws without enqueueing when fetch() returns more events than the per-poll cap", async () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ i }));
    registerPollingConnector(async () => ({ events: tooMany }));

    await expect(runJob()).rejects.toThrow(/exceeding the cap/);
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("throws without enqueueing further events when one event exceeds the max size", async () => {
    const oversized = { blob: "x".repeat(300_000) }; // > DEFAULT_MAX_OUTPUT_BYTES (256KB)
    registerPollingConnector(async () => ({ events: [oversized] }));

    await expect(runJob()).rejects.toThrow(/exceeding the cap/);
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips without throwing when the tenant is inactive", async () => {
    mockIsTenantActive.mockResolvedValue(false);
    registerPollingConnector(async () => ({ events: [{ x: 1 }] }));

    await runJob();

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
  });

  it("skips without throwing when the connector is not registered", async () => {
    await runJob();

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
  });

  it("skips without throwing when the connector has no polling trigger", async () => {
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
      triggers: [
        {
          id: "hook",
          name: "Webhook",
          description: "test",
          type: "webhook",
          webhook: { transform: async (raw) => raw as Record<string, unknown> },
        },
      ],
      actions: [],
    };
    registerConnector(definition);

    await runJob();

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
  });

  it("skips without throwing when the installation no longer exists", async () => {
    selectResult = [];
    registerPollingConnector(async () => ({ events: [{ x: 1 }] }));

    await runJob();

    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("skips without throwing when the installation is disabled (issue #367 kill switch)", async () => {
    selectResult = [
      {
        secrets: { k: "ciphertext" },
        cursorState: null,
        disabledAt: new Date(),
      },
    ];
    registerPollingConnector(async () => ({ events: [{ x: 1 }] }));

    await runJob();

    expect(mockConnectorInboundAdd).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
