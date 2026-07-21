import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetWorkflowEventLog = vi.fn();
// Read-access gate check (#127-adjacent IDOR fix) — resolves to an instance
// the "admin" role auth context always passes. Overridden per-test to
// exercise the not-found/cross-tenant path.
const mockGetEntityForAccess = vi.fn().mockResolvedValue({
  id: "irrelevant",
  createdBy: null,
  assignedTo: null,
  fields: {},
});

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

// Chainable DB mock: supports both .limit() and direct await (no .limit())
const mockTx: Record<string, unknown> = {
  select: () => mockTx,
  from: () => mockTx,
  where: () => mockTx,
  limit: () => Promise.resolve([]),
  then: (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve([]).then(resolve),
  catch: (reject: (e: unknown) => unknown) =>
    (Promise.resolve([]) as Promise<unknown[]>).catch(reject),
};

vi.mock("@platform/db", () => ({
  db: {},
  tenantUsers: {},
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: () => Promise.resolve([]),
  getUserById: () => Promise.resolve(null),
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    getWorkflowEventLog: (...args: unknown[]) =>
      mockGetWorkflowEventLog(...args),
  };
});

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntityForAccess(...args),
  };
});

const { listWorkflowEventsHandler } = await import("./list-workflow-events.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/transitions/history", ...listWorkflowEventsHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";

const fakeEvents = [
  {
    id: "00000000-0000-0000-0000-000000000099",
    instanceId: INST_ID,
    workflowId: "00000000-0000-0000-0000-000000000005",
    fromState: null,
    toState: "open",
    triggeredBy: "user" as const,
    actorId: "u-bbb",
    comment: null,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    id: "00000000-0000-0000-0000-000000000100",
    instanceId: INST_ID,
    workflowId: "00000000-0000-0000-0000-000000000005",
    fromState: "open",
    toState: "in_progress",
    triggeredBy: "user" as const,
    actorId: "u-bbb",
    comment: "Starting work",
    metadata: {},
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /entities/:id/transitions/history", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the event log in chronological order", async () => {
    mockGetWorkflowEventLog.mockResolvedValue(fakeEvents);

    const res = await makeApp().request(`/${INST_ID}/transitions/history`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.data[0].toState).toBe("open");
    expect(json.data[1].toState).toBe("in_progress");
  });

  it("passes tenantId and instanceId to getWorkflowEventLog", async () => {
    mockGetWorkflowEventLog.mockResolvedValue([]);

    await makeApp().request(`/${INST_ID}/transitions/history`, {
      method: "GET",
    });

    expect(mockGetWorkflowEventLog).toHaveBeenCalledWith(
      expect.any(Object),
      "t-aaa",
      INST_ID,
    );
  });

  it("returns 200 with an empty array for an instance with no events", async () => {
    mockGetWorkflowEventLog.mockResolvedValue([]);

    const res = await makeApp().request(`/${INST_ID}/transitions/history`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  it("returns 404 when instance belongs to another tenant (RLS)", async () => {
    // getEntity throws ENTITY_NOT_FOUND for a cross-tenant instance (RLS
    // scopes the underlying query to tenantId) — the read-access gate added
    // for the list-events.ts/list-relations.ts IDOR pattern now catches this
    // before getWorkflowEventLog is ever called, instead of silently
    // returning an empty array that leaked "this ID exists, no events".
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntityForAccess.mockRejectedValueOnce(
      new EntityError("ENTITY_NOT_FOUND", { instanceId: INST_ID }),
    );

    const res = await makeApp().request(`/${INST_ID}/transitions/history`, {
      method: "GET",
    });

    expect(res.status).toBe(404);
    expect(mockGetWorkflowEventLog).not.toHaveBeenCalled();
  });
});
