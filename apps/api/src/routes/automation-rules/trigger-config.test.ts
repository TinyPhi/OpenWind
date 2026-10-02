// #684: triggerConfig keys the admin-ui wizard sends must validate, and an
// empty string from a placeholder option is treated as unset, not stored.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as AutomationEngine from "@platform/automation-engine";

const mockCreate = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();

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
    getAutomationRule: (...args: unknown[]) => mockGet(...args),
    updateAutomationRule: (...args: unknown[]) => mockUpdate(...args),
  };
});

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createAutomationRuleHandler } = await import("./create.js");
const { updateAutomationRuleHandler } = await import("./update.js");

const RULE_ID = "00000000-0000-4000-a000-000000000684";
const WORKFLOW_ID = "11111111-0684-4000-a000-000000000001";
const ENTITY_TYPE_ID = "22222222-0684-4000-a000-000000000002";

const notify = [{ type: "notify", config: { channels: ["email"] } }];

function makeApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createAutomationRuleHandler);
  app.patch("/:id", ...updateAutomationRuleHandler);
  return app;
}

function create(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  actions: unknown[] = notify,
): Promise<Response> {
  return Promise.resolve(
    makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "r", triggerType, triggerConfig, actions }),
    }),
  );
}

function storedConfig(): unknown {
  const input = mockCreate.mock.calls[0]?.[2] as
    | { triggerConfig: unknown }
    | undefined;
  return input?.triggerConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: RULE_ID });
  mockUpdate.mockResolvedValue({ id: RULE_ID });
});

describe("trigger config keys the wizard sends", () => {
  it("accepts a state-entered rule as a transition keyed on toState", async () => {
    const res = await create("workflow.transitioned", {
      workflowId: WORKFLOW_ID,
      toState: "approved",
    });

    expect(res.status).toBe(201);
  });

  it("accepts a field-changed rule as an update keyed on field", async () => {
    const res = await create("entity.updated", {
      entityTypeId: ENTITY_TYPE_ID,
      field: "status",
    });

    expect(res.status).toBe(201);
  });

  it("accepts and validates state on an SLA-breached rule", async () => {
    const ok = await create("workflow.sla_breached", {
      workflowId: WORKFLOW_ID,
      state: "open",
    });
    expect(ok.status).toBe(201);
    expect(storedConfig()).toEqual({ workflowId: WORKFLOW_ID, state: "open" });

    const bad = await create("workflow.sla_breached", { state: 42 });
    expect(bad.status).toBe(400);
  });

  it("accepts a set-field action keyed on field", async () => {
    const res = await create("entity.created", {}, [
      { type: "set_field", config: { field: "status", value: "new" } },
    ]);

    expect(res.status).toBe(201);
  });

  it("accepts webhook headers as a name-to-value record", async () => {
    const res = await create("entity.created", {}, [
      {
        type: "webhook",
        config: { url: "https://example.com/h", headers: { "X-A": "1" } },
      },
    ]);

    expect(res.status).toBe(201);
  });
});

describe("empty-string trigger config values", () => {
  it("treats an empty placeholder id as unset instead of failing the uuid check", async () => {
    const res = await create("entity.created", { entityTypeId: "" });

    expect(res.status).toBe(201);
    expect(storedConfig()).toEqual({});
  });

  it("drops empty strings before storing the config", async () => {
    await create("workflow.transitioned", {
      workflowId: WORKFLOW_ID,
      fromState: "",
      toState: "done",
    });

    expect(storedConfig()).toEqual({
      workflowId: WORKFLOW_ID,
      toState: "done",
    });
  });

  it("treats an empty field on an update rule as any field", async () => {
    const res = await create("entity.updated", {
      entityTypeId: ENTITY_TYPE_ID,
      field: "",
    });

    expect(res.status).toBe(201);
    expect(storedConfig()).toEqual({ entityTypeId: ENTITY_TYPE_ID });
  });

  it("drops empty strings on update too", async () => {
    const res = await makeApp().request(`/${RULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        triggerType: "entity.created",
        triggerConfig: { entityTypeId: "" },
      }),
    });

    expect(res.status).toBe(200);
    const input = mockUpdate.mock.calls[0]?.[3] as
      | { triggerConfig: unknown }
      | undefined;
    expect(input?.triggerConfig).toEqual({});
  });
});
