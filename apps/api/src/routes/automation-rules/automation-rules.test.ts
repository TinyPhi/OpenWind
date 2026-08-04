import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as AutomationEngine from "@platform/automation-engine";

const mockCreate = vi.fn();
const mockList = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

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

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("@platform/automation-engine", async (importOriginal) => {
  const real = await importOriginal<typeof AutomationEngine>();
  return {
    ...real,
    createAutomationRule: (...args: unknown[]) => mockCreate(...args),
    listAutomationRules: (...args: unknown[]) => mockList(...args),
    getAutomationRule: (...args: unknown[]) => mockGet(...args),
    updateAutomationRule: (...args: unknown[]) => mockUpdate(...args),
    deleteAutomationRule: (...args: unknown[]) => mockDelete(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createAutomationRuleHandler } = await import("./create.js");
const { listAutomationRulesHandler } = await import("./list.js");
const { getAutomationRuleHandler } = await import("./get.js");
const { updateAutomationRuleHandler } = await import("./update.js");
const { deleteAutomationRuleHandler } = await import("./delete.js");

const RULE_ID = "00000000-0000-0000-0000-000000000020";

const fakeRule = {
  id: RULE_ID,
  tenantId: "t-aaa",
  name: "Close on transition",
  isEnabled: true,
  triggerType: "workflow.transitioned" as const,
  triggerConfig: {},
  conditions: null,
  actions: [{ type: "notify" as const, config: { channel: ["email"] } }],
  priority: 0,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createAutomationRuleHandler);
  app.get("/", ...listAutomationRulesHandler);
  app.get("/:id", ...getAutomationRuleHandler);
  app.patch("/:id", ...updateAutomationRuleHandler);
  app.delete("/:id", ...deleteAutomationRuleHandler);
  return app;
}

describe("POST /automation-rules", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 201 with created rule and preserves payload.link", async () => {
    mockCreate.mockResolvedValue(fakeRule);

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Close on transition",
        triggerType: "workflow.transitioned",
        triggerConfig: {},
        actions: [
          {
            type: "notify",
            config: {
              recipientId: "u-aaa",
              channel: ["email"],
              payload: { link: "/entities/abc" },
            },
          },
        ],
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.id).toBe(RULE_ID);
    expect(mockCreate).toHaveBeenCalledWith(
      {},
      "t-aaa",
      expect.objectContaining({
        name: "Close on transition",
        triggerType: "workflow.transitioned",
        actions: [
          expect.objectContaining({
            config: expect.objectContaining({
              payload: expect.objectContaining({
                link: "/entities/abc",
              }),
            }),
          }),
        ],
      }),
    );
  });

  it("returns 400 when triggerType is unknown", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        triggerType: "not.a.valid.trigger",
        triggerConfig: {},
        actions: [{ type: "notify", config: {} }],
      }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when actions array is empty", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        triggerType: "entity.created",
        triggerConfig: {},
        actions: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when create rejects with NOTIFY_LINK_INVALID", async () => {
    const { AutomationError } = await import("@platform/automation-engine");
    mockCreate.mockRejectedValue(new AutomationError("NOTIFY_LINK_INVALID"));

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Close on transition",
        triggerType: "workflow.transitioned",
        triggerConfig: {},
        actions: [
          {
            type: "notify",
            config: { recipientId: "u-aaa", channel: ["email"] },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("NOTIFY_LINK_INVALID");
  });

  it("returns 400 when create rejects with INVALID_EVENT_PAYLOAD", async () => {
    const { AutomationError } = await import("@platform/automation-engine");
    mockCreate.mockRejectedValue(
      new AutomationError("INVALID_EVENT_PAYLOAD", {
        reason: "Missing sendFields",
      }),
    );

    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Close on transition",
        triggerType: "workflow.transitioned",
        triggerConfig: {},
        actions: [
          {
            type: "notify",
            config: { recipientId: "u-aaa", channel: ["email"] },
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("INVALID_EVENT_PAYLOAD");
    expect(json.message).toBe("Missing sendFields");
  });
});

describe("GET /automation-rules", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with list of rules", async () => {
    mockList.mockResolvedValue([fakeRule]);

    const res = await makeApp().request("/");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith({}, "t-aaa", {
      triggerType: undefined,
      isEnabled: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it("passes triggerType and enabled filters", async () => {
    mockList.mockResolvedValue([]);

    await makeApp().request("/?triggerType=entity.created&enabled=true");

    expect(mockList).toHaveBeenCalledWith({}, "t-aaa", {
      triggerType: "entity.created",
      isEnabled: true,
      limit: 100,
      offset: 0,
    });
  });

  it("passes limit and offset to listAutomationRules (#261)", async () => {
    mockList.mockResolvedValue([]);

    await makeApp().request("/?limit=10&offset=20");

    expect(mockList).toHaveBeenCalledWith({}, "t-aaa", {
      triggerType: undefined,
      isEnabled: undefined,
      limit: 10,
      offset: 20,
    });
  });

  it("rejects limit above 500 with 400", async () => {
    const res = await makeApp().request("/?limit=501");
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe("GET /automation-rules/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with rule", async () => {
    mockGet.mockResolvedValue(fakeRule);

    const res = await makeApp().request(`/${RULE_ID}`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(RULE_ID);
  });

  it("returns 404 when rule not found", async () => {
    const { AutomationError } = await import("@platform/automation-engine");
    mockGet.mockRejectedValue(new AutomationError("RULE_NOT_FOUND"));

    const res = await makeApp().request(`/${RULE_ID}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /automation-rules/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with updated rule", async () => {
    mockUpdate.mockResolvedValue({ ...fakeRule, isEnabled: false });

    const res = await makeApp().request(`/${RULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isEnabled: false }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.isEnabled).toBe(false);
  });

  it("returns 404 when rule not found", async () => {
    const { AutomationError } = await import("@platform/automation-engine");
    mockUpdate.mockRejectedValue(new AutomationError("RULE_NOT_FOUND"));

    const res = await makeApp().request(`/${RULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("fetches existing rule to validate triggerConfig when triggerType is omitted from PATCH", async () => {
    mockGet.mockResolvedValue({
      ...fakeRule,
      triggerType: "field.changed",
      triggerConfig: {
        entityTypeId: "00000000-0000-0000-0000-000000000001",
        field: "status",
      },
    });
    mockUpdate.mockResolvedValue(fakeRule);

    // PATCH only triggerConfig — must fetch existing rule's triggerType
    // and validate the pair. Bad config for field.changed (missing required field) → 422.
    const res = await makeApp().request(`/${RULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        triggerConfig: { entityTypeId: "not-a-uuid" }, // missing `field`, bad uuid
      }),
    });

    expect(res.status).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("fetches existing rule to validate triggerConfig when only triggerType changes", async () => {
    mockGet.mockResolvedValue({
      ...fakeRule,
      triggerType: "entity.created",
      triggerConfig: {},
    });
    mockUpdate.mockResolvedValue(fakeRule);

    // Changing triggerType to field.changed but keeping the existing empty triggerConfig.
    // field.changed requires entityTypeId and field — existing {} is invalid → 422.
    const res = await makeApp().request(`/${RULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerType: "field.changed" }),
    });

    expect(res.status).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE /automation-rules/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 204 on success", async () => {
    mockDelete.mockResolvedValue(undefined);

    const res = await makeApp().request(`/${RULE_ID}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith({}, "t-aaa", RULE_ID);
  });

  it("returns 404 when rule not found", async () => {
    const { AutomationError } = await import("@platform/automation-engine");
    mockDelete.mockRejectedValue(new AutomationError("RULE_NOT_FOUND"));

    const res = await makeApp().request(`/${RULE_ID}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
