// #684 part 2: trigger types nothing emits are rejected with a pointer to
// their replacement, trigger configs are strict, and a rule disabled by
// migration 0132 can't be switched back on.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as AutomationEngine from "@platform/automation-engine";
import { TRIGGER_SCOPE_KEYS } from "@platform/automation-engine";

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
const { TRIGGER_CONFIG_SCHEMAS, TRIGGER_TYPES } = await import("./schemas.js");

const RULE_ID = "00000000-0000-4000-a000-000000000684";
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
): Promise<Response> {
  return Promise.resolve(
    makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "r",
        triggerType,
        triggerConfig,
        actions: notify,
      }),
    }),
  );
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    makeApp().request(`/${RULE_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: RULE_ID });
  mockUpdate.mockResolvedValue({ id: RULE_ID });
});

describe("retired trigger types", () => {
  it.each([
    ["workflow.entered_state", "workflow.transitioned"],
    ["field.changed", "entity.updated"],
    ["schedule.cron", "schedule rule"],
    ["connector.event", "#368"],
  ])("rejects %s and points to %s", async (type, hint) => {
    const res = await create(type, {});

    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(hint);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses to re-enable a rule stored with a retired type", async () => {
    mockGet.mockResolvedValue({
      id: RULE_ID,
      triggerType: "schedule.cron",
      triggerConfig: { cron: "0 9 * * *" },
    });

    const res = await patch({ isEnabled: true });

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "TRIGGER_TYPE_RETIRED" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("lets a retired rule be enabled once it moves to a supported type", async () => {
    const res = await patch({
      isEnabled: true,
      triggerType: "entity.updated",
      triggerConfig: { field: "status" },
    });

    expect(res.status).toBe(200);
  });

  it("still allows enabling a rule on a supported type", async () => {
    mockGet.mockResolvedValue({
      id: RULE_ID,
      triggerType: "entity.created",
      triggerConfig: {},
    });

    const res = await patch({ isEnabled: true });

    expect(res.status).toBe(200);
  });
});

describe("strict trigger config", () => {
  it("rejects a key the trigger type does not define", async () => {
    const res = await create("entity.created", { fieldName: "status" });

    expect(res.status).toBe(400);
  });

  it("accepts the entityType name key that module-seeded rules use", async () => {
    const res = await create("entity.updated", {
      entityType: "ticket",
      field: "status",
    });

    expect(res.status).toBe(201);
  });

  it("accepts entityTypeId on a workflow trigger, which the executor scopes on", async () => {
    const res = await create("workflow.transitioned", {
      entityTypeId: ENTITY_TYPE_ID,
      toState: "done",
    });

    expect(res.status).toBe(201);
  });

  it.each([...TRIGGER_TYPES])(
    "allows every key the executor scopes %s on",
    (type) => {
      const scopeKeys = Object.keys(TRIGGER_SCOPE_KEYS[type] ?? {});
      const allowed = Object.keys(TRIGGER_CONFIG_SCHEMAS[type].shape);

      expect(scopeKeys.length).toBeGreaterThan(0);
      for (const key of [...scopeKeys, "entityType"]) {
        expect(allowed).toContain(key);
      }
    },
  );
});
