import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as WorkflowEngine from "@platform/workflow-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetAvailableTransitions = vi.fn();

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
    getAvailableTransitions: (...args: unknown[]) =>
      mockGetAvailableTransitions(...args),
  };
});

const { listTransitionsHandler } = await import("./list-transitions.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id/transitions", ...listTransitionsHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";

const fakeTransitions = [
  {
    id: "00000000-0000-0000-0000-000000000010",
    workflowId: "00000000-0000-0000-0000-000000000005",
    fromState: "open",
    toState: "in_progress",
    label: "Start",
    allowedRoles: ["admin", "agent"],
    conditions: null,
    requiresComment: false,
    requiresFields: [],
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /entities/:id/transitions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with the list of available transitions", async () => {
    mockGetAvailableTransitions.mockResolvedValue(fakeTransitions);

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(fakeTransitions[0].id);
  });

  it("passes tenantId and actor roles to getAvailableTransitions", async () => {
    mockGetAvailableTransitions.mockResolvedValue([]);

    await makeApp().request(`/${INST_ID}/transitions`, { method: "GET" });

    expect(mockGetAvailableTransitions).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INST_ID,
      ["admin"],
    );
  });

  it("returns 200 with an empty array when no transitions are available", async () => {
    mockGetAvailableTransitions.mockResolvedValue([]);

    const res = await makeApp().request(`/${INST_ID}/transitions`, {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  it("restricts / clamps the query parameter roles to only those present in the verified auth token", async () => {
    mockGetAvailableTransitions.mockResolvedValue([]);

    await makeApp().request(
      `/${INST_ID}/transitions?roles=admin,agent,superuser`,
      {
        method: "GET",
      },
    );

    expect(mockGetAvailableTransitions).toHaveBeenCalledWith(
      {},
      "t-aaa",
      INST_ID,
      ["admin"],
    );
  });
});
