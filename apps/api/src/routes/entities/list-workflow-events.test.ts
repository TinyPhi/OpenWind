import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetWorkflowEventLog = vi.fn();

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

vi.mock("@platform/db", () => ({ db: {} }));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    getWorkflowEventLog: (...args: unknown[]) =>
      mockGetWorkflowEventLog(...args),
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

    expect(mockGetWorkflowEventLog).toHaveBeenCalledWith({}, "t-aaa", INST_ID);
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

  it("returns 200 with empty array when instance belongs to another tenant (RLS)", async () => {
    // getWorkflowEventLog returns [] when instance is not found (RLS/404-as-empty)
    mockGetWorkflowEventLog.mockResolvedValue([]);

    const res = await makeApp().request(`/${INST_ID}/transitions/history`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });
});
