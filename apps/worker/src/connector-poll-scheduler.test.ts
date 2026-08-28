/**
 * connector-poll-scheduler.test.ts
 *
 * Unit tests for the reconcile-tick scheduler (issue #366, ADR-009
 * Decision #7). DB and queues.js are mocked. @platform/connector-sdk's real
 * in-process registry is used (registerConnector/__resetConnectorRegistryForTests)
 * — matching connector-outbound-worker.test.ts's convention.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConnectorDefinition } from "@platform/connector-sdk";

// ── @platform/db ─────────────────────────────────────────────────────────────

let installationRows: Array<{
  tenantId: string;
  connectorId: string;
  disabledAt?: Date | null;
}>;
// The real query filters disabled installations in SQL (WHERE
// isNull(disabledAt)), so the mock chain does the same — a test asserting
// "a disabled installation never enters the desired set" would otherwise
// pass or fail for the wrong reason depending on whether this mock happens
// to forward .where()'s filtering intent.
const mockDbWhere = vi.fn(() =>
  Promise.resolve(installationRows.filter((r) => !r.disabledAt)),
);
const mockDbFrom = vi.fn(() => ({ where: mockDbWhere }));
const mockDbSelect = vi.fn(() => ({ from: mockDbFrom }));

vi.mock("@platform/db", () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
  connectorCredentials: {
    tenantId: "tenantId",
    connectorId: "connectorId",
    disabledAt: "disabledAt",
  },
}));

// ── ./queues.js ──────────────────────────────────────────────────────────────

let repeatableJobs: Array<{ key: string; every?: string | null }>;
const mockGetRepeatableJobs = vi.fn(() => Promise.resolve(repeatableJobs));
const mockRemoveRepeatableByKey = vi.fn().mockResolvedValue(undefined);
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("./queues.js", () => ({
  connectorPollQueue: {
    getRepeatableJobs: (...args: unknown[]) => mockGetRepeatableJobs(...args),
    removeRepeatableByKey: (...args: unknown[]) =>
      mockRemoveRepeatableByKey(...args),
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

// ── @platform/logger ─────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────────

const { registerConnector, __resetConnectorRegistryForTests } =
  await import("@platform/connector-sdk");
const {
  reconcile,
  pollJobId,
  startConnectorPollScheduler,
  stopConnectorPollScheduler,
} = await import("./connector-poll-scheduler.js");

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";
const CONNECTOR_ID = "connector-1";

function registerConnectorWithTriggers(
  triggers: ConnectorDefinition["triggers"],
): void {
  registerConnector({
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
    triggers,
    actions: [],
  });
}

function registerPollingConnector(intervalMinutes = 5): void {
  registerConnectorWithTriggers([
    {
      id: "poll",
      name: "Poll",
      description: "test",
      type: "polling",
      polling: { intervalMinutes, fetch: async () => ({ events: [] }) },
    },
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("connector poll scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetConnectorRegistryForTests();
    installationRows = [];
    repeatableJobs = [];
  });

  describe("reconcile", () => {
    it("adds a repeatable job for a new polling installation", async () => {
      registerPollingConnector(5);
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];

      await reconcile();

      expect(mockRemoveRepeatableByKey).not.toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "connector.poll",
        { tenantId: TENANT_ID, connectorId: CONNECTOR_ID },
        {
          repeat: {
            key: pollJobId(TENANT_ID, CONNECTOR_ID),
            every: 5 * 60_000,
          },
        },
      );
    });

    it("removes a repeatable job whose installation no longer exists", async () => {
      installationRows = []; // uninstalled
      repeatableJobs = [
        { key: pollJobId(TENANT_ID, CONNECTOR_ID), every: "300000" },
      ];

      await reconcile();

      expect(mockRemoveRepeatableByKey).toHaveBeenCalledWith(
        pollJobId(TENANT_ID, CONNECTOR_ID),
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("removes and re-adds a repeatable job when intervalMinutes changed", async () => {
      registerPollingConnector(10); // now wants 600_000ms
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];
      repeatableJobs = [
        { key: pollJobId(TENANT_ID, CONNECTOR_ID), every: "300000" }, // stale 5min
      ];

      await reconcile();

      expect(mockRemoveRepeatableByKey).toHaveBeenCalledWith(
        pollJobId(TENANT_ID, CONNECTOR_ID),
      );
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "connector.poll",
        { tenantId: TENANT_ID, connectorId: CONNECTOR_ID },
        { repeat: { key: pollJobId(TENANT_ID, CONNECTOR_ID), every: 600_000 } },
      );
    });

    it("leaves a matching repeatable job alone — no remove AND no re-add", async () => {
      // Regression guard: BullMQ's addRepeatableJob script cancels and
      // re-derives the pending delayed job's next-fire time on EVERY add()
      // call, even when repeat.key/every are unchanged — so calling add()
      // unconditionally every tick would keep resetting the schedule before
      // it ever fires, the same "never fires" bug the key-matching fix
      // addresses via the remove path. Both sides must be inert here.
      registerPollingConnector(5);
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];
      repeatableJobs = [
        { key: pollJobId(TENANT_ID, CONNECTOR_ID), every: "300000" },
      ];

      await reconcile();

      expect(mockRemoveRepeatableByKey).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("skips an installation whose connector declares an invalid intervalMinutes", async () => {
      registerConnectorWithTriggers([
        {
          id: "poll",
          name: "Poll",
          description: "test",
          type: "polling",
          polling: { intervalMinutes: 0, fetch: async () => ({ events: [] }) },
        },
      ]);
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];

      await reconcile();

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockRemoveRepeatableByKey).not.toHaveBeenCalled();
    });

    it("excludes a disabled installation from the desired set (issue #367 kill switch)", async () => {
      registerPollingConnector(5);
      installationRows = [
        {
          tenantId: TENANT_ID,
          connectorId: CONNECTOR_ID,
          disabledAt: new Date(),
        },
      ];

      await reconcile();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("removes an existing repeatable job once its installation becomes disabled", async () => {
      registerPollingConnector(5);
      installationRows = [
        {
          tenantId: TENANT_ID,
          connectorId: CONNECTOR_ID,
          disabledAt: new Date(),
        },
      ];
      repeatableJobs = [
        { key: pollJobId(TENANT_ID, CONNECTOR_ID), every: "300000" },
      ];

      await reconcile();

      expect(mockRemoveRepeatableByKey).toHaveBeenCalledWith(
        pollJobId(TENANT_ID, CONNECTOR_ID),
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("skips an installation whose connector is not registered", async () => {
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];

      await reconcile();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("skips an installation whose connector has no polling trigger", async () => {
      registerConnectorWithTriggers([
        {
          id: "hook",
          name: "Webhook",
          description: "test",
          type: "webhook",
          webhook: { transform: async (raw) => raw as Record<string, unknown> },
        },
      ]);
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];

      await reconcile();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("does not throw when the DB query fails — logs and returns", async () => {
      mockDbWhere.mockRejectedValueOnce(new Error("connection reset"));

      await expect(reconcile()).resolves.toBeUndefined();
    });
  });

  describe("startConnectorPollScheduler / stopConnectorPollScheduler", () => {
    it("fires the first reconcile tick immediately on startup", async () => {
      vi.useFakeTimers();
      installationRows = [];

      startConnectorPollScheduler(60_000);
      await Promise.resolve();

      expect(mockDbSelect).toHaveBeenCalled();

      await stopConnectorPollScheduler();
      vi.useRealTimers();
    });

    it("skips a scheduled tick if the previous tick is still running", async () => {
      vi.useFakeTimers();

      let resolveTick!: () => void;
      const slowTick = new Promise<unknown[]>((res) => {
        resolveTick = res as unknown as () => void;
      });
      mockDbWhere.mockReturnValueOnce(slowTick);

      startConnectorPollScheduler(100);
      await Promise.resolve();

      vi.advanceTimersByTime(150);
      await Promise.resolve();

      expect(mockDbSelect).toHaveBeenCalledTimes(1);

      resolveTick([]);
      await stopConnectorPollScheduler();
      vi.useRealTimers();
    });
  });
});
