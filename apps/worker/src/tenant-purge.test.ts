/**
 * PR #869 review R3: the purge worker's G5 audit entries (purge.completed, and purge.failed on
 * the final attempt) must be written inside withTenantContext. admin_audit_log is RLS-protected
 * and the worker connects as app_user, so a write on the plain connection is rejected -- after
 * the tenants status flip has committed, which made every retry fail the same way.
 *
 * The DB work itself is covered by the tenant-purge isolation tests; this file only checks which
 * connection each audit write goes through, so every query builder is a chainable stub.
 *
 * Migration 0144: the privileged pre-steps (schedule_rules archive, schedule_executions and
 * saved_views deletes, audit-log anonymization) go through withTenantPurgeContext, never plain
 * db -- on an app_user connection plain db either lacks the grant or, with no tenant context,
 * RLS makes the statement match nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Processor = (job: unknown) => Promise<void>;
type FailedHandler = (job: unknown, err: Error) => void;

const { captured } = vi.hoisted(() => ({
  captured: {} as { processor?: Processor; onFailed?: FailedHandler },
}));

vi.mock("@platform/telemetry", () => ({
  Worker: class {
    constructor(_name: string, processor: Processor) {
      captured.processor = processor;
    }
    on(event: string, handler: FailedHandler): void {
      if (event === "failed") captured.onFailed = handler;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

// A query builder stand-in: every method returns itself and awaiting it yields `result`.
function chain(result: unknown): unknown {
  const target = (): unknown => proxy;
  const proxy: unknown = new Proxy(target, {
    get: (_t, prop) =>
      prop === "then"
        ? (resolve: (v: unknown) => unknown) => resolve(result)
        : proxy,
    apply: () => proxy,
  });
  return proxy;
}

// Values the lifecycle connection's tenants update was asked to set (the 'purged' tombstone).
const lifecycleSets: unknown[] = [];
const lifecycleTx = new Proxy(
  {},
  {
    get: (_t, p) =>
      p === "update"
        ? () => ({
            set: (values: unknown) => {
              lifecycleSets.push(values);
              return chain([]);
            },
          })
        : () => chain([]),
  },
);

const PLAIN_DB = { kind: "plain-db" };
const TENANT_TX = { kind: "tenant-tx" };
const PURGE_TX = { kind: "purge-tx" };

// Which tables each connection wrote to (update/delete), recorded by table name.
const writes: Record<"plain" | "purge" | "eventLog", string[]> = {
  plain: [],
  purge: [],
  eventLog: [],
};
function recordingConn(
  base: { kind: string },
  bucket: "plain" | "purge",
  onSelect: () => unknown,
): unknown {
  return new Proxy(base, {
    get: (t, p) => {
      if (p === "kind") return t.kind;
      if (p === "select") return () => chain(onSelect());
      if (p === "update" || p === "delete") {
        return (table: { table?: string }) => {
          writes[bucket].push(`${String(p)}:${table.table ?? "?"}`);
          return chain([]);
        };
      }
      return () => chain([]);
    },
  });
}

const mockWithTenantPurgeContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(recordingConn(PURGE_TX, "purge", () => [])),
);

const mockWithEventLogMaintenanceContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(recordingConn({ kind: "event-log-tx" }, "eventLog", () => [])),
);

const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(
      new Proxy(TENANT_TX, {
        get: (t, p) => (p === "kind" ? t.kind : chain([])),
      }),
    ),
);
const mockTenantStatus = vi.fn(() => [{ status: "deleted" }]);

vi.mock("@platform/db", () => {
  const db = recordingConn(PLAIN_DB, "plain", () => mockTenantStatus());
  // vitest needs every named export listed; each table only has to be a distinct object.
  const tableNames = [
    "tenants",
    "files",
    "viewConfigs",
    "apiKeys",
    "tenantUsers",
    "connectorCredentials",
    "installedPlugins",
    "pluginErrors",
    "pluginDefinitions",
    "entityInstances",
    "entityRelations",
    "entityFields",
    "entityTypes",
    "workflows",
    "workflowStates",
    "workflowTransitions",
    "workflowEvents",
    "automationRules",
    "automationExecutions",
    "outboxEvents",
    "deadLetterEvents",
    "connectorDeliveryAttempts",
    "idempotencyKeys",
    "ticketAlerts",
    "accessRequests",
    "attachments",
    "notifications",
    "notificationRecipients",
    "savedViews",
    "labels",
    "ticketLabels",
    "entityInstanceTags",
    "teams",
    "services",
    "onCallSchedules",
    "notificationPolicies",
    "scheduleRules",
    "scheduleExecutions",
    "orgEmployees",
    "orgDirectorySyncRuns",
  ];
  return {
    ...Object.fromEntries(tableNames.map((name) => [name, { table: name }])),
    db,
    withTenantContext: (...args: Parameters<typeof mockWithTenantContext>) =>
      mockWithTenantContext(...args),
    withTenantLifecycleContext: (fn: (tx: unknown) => unknown) =>
      fn(lifecycleTx),
    withEventLogMaintenanceContext: (
      ...args: Parameters<typeof mockWithEventLogMaintenanceContext>
    ) => mockWithEventLogMaintenanceContext(...args),
    withTenantPurgeContext: (
      ...args: Parameters<typeof mockWithTenantPurgeContext>
    ) => mockWithTenantPurgeContext(...args),
    purgeTenantDataFromPluginSchema: vi.fn(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));

const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);
const mockAnonymize = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
  anonymizeAuditLogForTenant: (...args: unknown[]) => mockAnonymize(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { mockDeleteFiles, mockDeleteHandover } = vi.hoisted(() => ({
  mockDeleteFiles: vi.fn(),
  mockDeleteHandover: vi.fn(),
}));
vi.mock("@platform/files", () => ({ deleteTenantFiles: mockDeleteFiles }));
vi.mock("@platform/auth", () => ({
  deleteSandboxHandoverCredentials: mockDeleteHandover,
}));
vi.mock("./queues.js", () => ({ connection: {} }));
const { mockEnqueueFlush } = vi.hoisted(() => ({ mockEnqueueFlush: vi.fn() }));
vi.mock("./superset-cache-flush.js", () => ({
  enqueueSupersetCacheFlush: mockEnqueueFlush,
}));

const { mockEnqueueErasure } = vi.hoisted(() => ({
  mockEnqueueErasure: vi.fn(),
}));
vi.mock("./superset-erasure.js", () => ({
  enqueueSupersetErasure: mockEnqueueErasure,
}));
const { mockErasureMode } = vi.hoisted(() => ({ mockErasureMode: vi.fn() }));
vi.mock("@platform/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  supersetErasureMode: mockErasureMode,
}));

await import("./tenant-purge.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function auditCall(action: string): unknown[] | undefined {
  return mockWriteAuditEntry.mock.calls.find(
    ([, entry]) => (entry as { action?: string }).action === action,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantStatus.mockReturnValue([{ status: "deleted" }]);
  mockErasureMode.mockReturnValue("full");
  mockEnqueueErasure.mockResolvedValue(true);
  writes.plain.length = 0;
  writes.purge.length = 0;
  writes.eventLog.length = 0;
  lifecycleSets.length = 0;
});

describe("tenant-purge retry after the DB purge committed", () => {
  const job = { id: "job-1", attemptsMade: 1, data: { tenantId: TENANT_ID } };

  it("still deletes files and handover credentials and queues the cache flush for an already purged tenant", async () => {
    mockTenantStatus.mockReturnValue([{ status: "purged" }]);
    await captured.processor?.(job);

    expect(mockDeleteFiles).toHaveBeenCalledWith(TENANT_ID);
    expect(mockDeleteHandover).toHaveBeenCalledWith(TENANT_ID);
    expect(mockEnqueueFlush).toHaveBeenCalledWith(TENANT_ID, "tenant_purged");
  });

  it("does not redo the database purge or write another completion entry", async () => {
    mockTenantStatus.mockReturnValue([{ status: "purged" }]);
    await captured.processor?.(job);

    expect(auditCall("purge.completed")).toBeUndefined();
    expect(mockWithTenantContext).not.toHaveBeenCalled();
  });

  it("finishes the retry even when file deletion fails again", async () => {
    mockTenantStatus.mockReturnValue([{ status: "purged" }]);
    mockDeleteFiles.mockRejectedValueOnce(new Error("disk busy"));
    await expect(captured.processor?.(job)).resolves.toBeUndefined();
    expect(mockDeleteHandover).toHaveBeenCalledWith(TENANT_ID);
  });

  it("cleans nothing for a tenant in any other state", async () => {
    mockTenantStatus.mockReturnValue([{ status: "active" }]);
    await captured.processor?.(job);

    expect(mockDeleteFiles).not.toHaveBeenCalled();
    expect(mockDeleteHandover).not.toHaveBeenCalled();
  });
});

describe("tenant-purge Superset cache flush (#728)", () => {
  it("queues one flush for the purged tenant after the purge", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });
    expect(mockEnqueueFlush).toHaveBeenCalledTimes(1);
    expect(mockEnqueueFlush).toHaveBeenCalledWith(TENANT_ID, "tenant_purged");
  });
});

describe("tenant-purge Superset erasure (#728)", () => {
  it("queues the tenant's Superset erasure after the purge", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });
    expect(mockEnqueueErasure).toHaveBeenCalledTimes(1);
    expect(mockEnqueueErasure).toHaveBeenCalledWith({
      kind: "tenant",
      tenantId: TENANT_ID,
    });
  });

  it("queues it again on a retry after the purge committed, so a lost enqueue is not final", async () => {
    mockTenantStatus.mockReturnValue([{ status: "purged" }]);
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 1,
      data: { tenantId: TENANT_ID },
    });
    expect(mockEnqueueErasure).toHaveBeenCalledWith({
      kind: "tenant",
      tenantId: TENANT_ID,
    });
  });

  it("fails the purge job when the erasure cannot be queued, so its retry queues it again", async () => {
    mockEnqueueErasure.mockResolvedValueOnce(false);
    await expect(
      captured.processor?.({
        id: "job-1",
        attemptsMade: 0,
        data: { tenantId: TENANT_ID },
      }),
    ).rejects.toThrow("the Superset erasure could not be queued");
  });

  it("does not fail the purge when Stage 2 is off and nothing is queued", async () => {
    mockErasureMode.mockReturnValue("cache-only");
    await expect(
      captured.processor?.({
        id: "job-1",
        attemptsMade: 0,
        data: { tenantId: TENANT_ID },
      }),
    ).resolves.toBeUndefined();
    expect(mockEnqueueErasure).not.toHaveBeenCalled();
  });
});

describe("tenant-purge tombstone (R12)", () => {
  it("clears the sandbox logo when it marks the tenant purged", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });

    expect(lifecycleSets).toEqual([
      expect.objectContaining({ status: "purged", logo: null }),
    ]);
  });
});

describe("tenant-purge audit writes", () => {
  it("writes purge.completed inside the purged tenant's context, not on plain db", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });

    const call = auditCall("purge.completed");
    expect(call).toBeDefined();
    expect((call?.[0] as { kind?: string }).kind).toBe("tenant-tx");
    expect(mockWithTenantContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("anonymizes the audit log inside the purge role's context for this tenant", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });

    expect(mockAnonymize).toHaveBeenCalledTimes(1);
    const [conn, tenantId] = mockAnonymize.mock.calls[0] as [
      { kind?: string },
      string,
    ];
    expect(conn.kind).toBe("purge-tx");
    expect(tenantId).toBe(TENANT_ID);
    expect(mockWithTenantPurgeContext).toHaveBeenCalledTimes(1);
    expect(mockWithTenantPurgeContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("runs the privileged pre-steps through the purge role, never plain db", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });

    expect(writes.purge).toEqual([
      "update:scheduleRules",
      "delete:scheduleExecutions",
      "delete:savedViews",
    ]);
    // app_user cannot delete workflow events (migration 0147): only the maintenance context does.
    expect(writes.eventLog).toEqual(["delete:workflowEvents"]);
    expect(writes.plain).toEqual([]);
    expect(mockWithTenantPurgeContext).toHaveBeenCalledTimes(1);
  });

  it("aborts purge and bubbles error when audit anonymization fails (#931)", async () => {
    mockAnonymize.mockRejectedValueOnce(
      new Error("simulated anonymization failure"),
    );

    await expect(
      captured.processor?.({
        id: "job-fail-anonymize",
        attemptsMade: 0,
        data: { tenantId: TENANT_ID },
      }),
    ).rejects.toThrow("simulated anonymization failure");

    // The privileged pre-steps transaction ran and failed
    expect(mockWithTenantPurgeContext).toHaveBeenCalledTimes(1);
    // Downstream main delete transaction and completion audit entry must NOT have executed
    // (withTenantContext only called once for the preceding plugin definitions lookup)
    expect(mockWithTenantContext).toHaveBeenCalledTimes(1);
    expect(auditCall("purge.completed")).toBeUndefined();
    expect(writes.plain).toEqual([]);
  });

  it("writes purge.failed inside the tenant's context on the final attempt", async () => {
    captured.onFailed?.(
      {
        id: "job-2",
        attemptsMade: 3,
        opts: { attempts: 3 },
        data: { tenantId: TENANT_ID },
      },
      new Error("boom"),
    );
    await vi.waitFor(() => {
      expect(auditCall("purge.failed")).toBeDefined();
    });

    const call = auditCall("purge.failed");
    expect((call?.[0] as { kind?: string }).kind).toBe("tenant-tx");
    expect(mockWithTenantContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
  });

  it("writes no failure entry before the final attempt", () => {
    captured.onFailed?.(
      {
        id: "job-3",
        attemptsMade: 1,
        opts: { attempts: 3 },
        data: { tenantId: TENANT_ID },
      },
      new Error("transient"),
    );

    expect(auditCall("purge.failed")).toBeUndefined();
  });
});
