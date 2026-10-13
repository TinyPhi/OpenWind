/**
 * PR #869 review R3: the purge worker's G5 audit entries (purge.completed, and purge.failed on
 * the final attempt) must be written inside withTenantContext. admin_audit_log is RLS-protected
 * and the worker connects as app_user, so a write on the plain connection is rejected -- after
 * the tenants status flip has committed, which made every retry fail the same way.
 *
 * The DB work itself is covered by the tenant-purge isolation tests; this file only checks which
 * connection each audit write goes through, so every query builder is a chainable stub.
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

const PLAIN_DB = { kind: "plain-db" };
const TENANT_TX = { kind: "tenant-tx" };

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
  const db = new Proxy(PLAIN_DB, {
    get: (t, p) => {
      if (p === "kind") return t.kind;
      if (p === "select") return () => chain(mockTenantStatus());
      return () => chain([]);
    },
  });
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
    withTenantLifecycleContext: (fn: (tx: unknown) => unknown) => fn(chain([])),
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
vi.mock("@platform/files", () => ({ deleteTenantFiles: vi.fn() }));
vi.mock("@platform/auth", () => ({
  deleteSandboxHandoverCredentials: vi.fn(),
}));
vi.mock("./queues.js", () => ({ connection: {} }));

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

  it("still anonymizes the audit log on plain db (an UPDATE app_user is not granted)", async () => {
    await captured.processor?.({
      id: "job-1",
      attemptsMade: 0,
      data: { tenantId: TENANT_ID },
    });

    expect(mockAnonymize).toHaveBeenCalledWith(PLAIN_DB, TENANT_ID);
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
