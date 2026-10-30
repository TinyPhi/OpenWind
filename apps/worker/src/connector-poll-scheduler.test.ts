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
let tenantRows: Array<{ id: string; trialEndsAt: Date | null }>;
// Tenant ids whose per-tenant installation lookup should throw.
let failingTenants: Set<string>;

// The real per-tenant query filters disabled installations in SQL (WHERE
// isNull(disabledAt)) for the tenant given to withTenantContext, so the mock
// does the same — otherwise a "disabled installation never enters the desired
// set" test could pass or fail for the wrong reason.
const mockWithTenantContext = vi.fn(
  async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    if (failingTenants.has(tenantId)) throw new Error("connection reset");
    const rows = installationRows
      .filter((r) => r.tenantId === tenantId && !r.disabledAt)
      .map((r) => ({ connectorId: r.connectorId }));
    const tx = {
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    };
    return fn(tx);
  },
);
const mockTenantWhere = vi.fn(() => Promise.resolve(tenantRows));
const mockDbSelect = vi.fn(() => ({
  from: () => ({ where: mockTenantWhere }),
}));

vi.mock("@platform/db", () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
  withTenantContext: (
    ...args: Parameters<typeof mockWithTenantContext>
  ): ReturnType<typeof mockWithTenantContext> => mockWithTenantContext(...args),
  tenants: { id: "id", trialEndsAt: "trialEndsAt", status: "status" },
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
    failingTenants = new Set();
    tenantRows = [{ id: TENANT_ID, trialEndsAt: null }];
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

    it("does not throw when the tenant listing fails — logs and returns", async () => {
      mockTenantWhere.mockRejectedValueOnce(new Error("connection reset"));

      await expect(reconcile()).resolves.toBeUndefined();
    });

    it("queries each tenant's installations inside withTenantContext (issue #1078)", async () => {
      registerPollingConnector(5);
      tenantRows = [
        { id: "tenant-a", trialEndsAt: null },
        { id: "tenant-b", trialEndsAt: null },
      ];
      installationRows = [
        { tenantId: "tenant-a", connectorId: CONNECTOR_ID },
        { tenantId: "tenant-b", connectorId: CONNECTOR_ID },
      ];

      await reconcile();

      expect(mockWithTenantContext.mock.calls.map((c) => c[0])).toEqual([
        "tenant-a",
        "tenant-b",
      ]);
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    });

    it("a failing tenant does not block others and keeps its existing jobs", async () => {
      registerPollingConnector(5);
      tenantRows = [
        { id: "tenant-bad", trialEndsAt: null },
        { id: "tenant-ok", trialEndsAt: null },
      ];
      failingTenants = new Set(["tenant-bad"]);
      installationRows = [{ tenantId: "tenant-ok", connectorId: CONNECTOR_ID }];
      repeatableJobs = [
        { key: pollJobId("tenant-bad", CONNECTOR_ID), every: "300000" },
      ];

      await reconcile();

      expect(mockRemoveRepeatableByKey).not.toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "connector.poll",
        { tenantId: "tenant-ok", connectorId: CONNECTOR_ID },
        expect.anything(),
      );
    });

    it("skips tenants whose sandbox trial has expired", async () => {
      registerPollingConnector(5);
      tenantRows = [
        { id: TENANT_ID, trialEndsAt: new Date(Date.now() - 1000) },
      ];
      installationRows = [{ tenantId: TENANT_ID, connectorId: CONNECTOR_ID }];

      await reconcile();

      expect(mockQueueAdd).not.toHaveBeenCalled();
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
      mockTenantWhere.mockReturnValueOnce(slowTick as never);

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
