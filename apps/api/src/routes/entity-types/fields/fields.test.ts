import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockUpdateEntityField = vi.fn();
const requireRoleCalls: string[][] = [];

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
  requireRole: (...roles: string[]) => {
    requireRoleCalls.push(roles);
    return async (_c: Context, next: Next) => {
      await next();
    };
  },
}));

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (tenantId, fn) => fn({}),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    updateEntityField: (...args: unknown[]) => mockUpdateEntityField(...args),
  };
});

const { updateEntityFieldHandler } = await import("./update-field.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp(typeId = "") {
  const app = new Hono<{ Variables: { auth: AuthContext; typeId: string } }>();
  // Simulate the parent router middleware that sets typeId on the context
  app.use("*", async (c, next) => {
    c.set("typeId", typeId);
    await next();
  });
  app.patch("/:fieldId", ...updateEntityFieldHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TYPE_ID = "00000000-0000-0000-0000-000000000001";
const FIELD_ID = "00000000-0000-0000-0000-000000000002";

function makeField(
  overrides: Partial<EntityEngine.EntityField> = {},
): EntityEngine.EntityField {
  return {
    id: FIELD_ID,
    entityTypeId: TYPE_ID,
    tenantId: "t-aaa",
    name: "description",
    label: "Description",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /entity-types/:typeId/fields/:fieldId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is gated to admin/agent/user, with real access enforced per-workflow", () => {
    expect(requireRoleCalls).toContainEqual(["admin", "agent", "user"]);
  });

  it("returns 200 with the updated field on a valid label change", async () => {
    mockUpdateEntityField.mockResolvedValue(makeField({ label: "Details" }));

    const res = await makeApp().request(`/${FIELD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Details" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.label).toBe("Details");
  });

  it("returns 400 when body is empty (zod refine: at least one field required)", async () => {
    const res = await makeApp().request(`/${FIELD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateEntityField).not.toHaveBeenCalled();
  });

  it("returns 422 with INVALID_FORMAT on config.pattern when engine throws ValidationError for ReDoS-vulnerable regex", async () => {
    const { ValidationError } = await import("@platform/entity-engine");
    mockUpdateEntityField.mockRejectedValue(
      new ValidationError([
        {
          field: "config.pattern",
          code: "INVALID_FORMAT",
          message:
            "Pattern is invalid or vulnerable to ReDoS — use a simpler regex",
        },
      ]),
    );

    const res = await makeApp().request(`/${FIELD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { pattern: "(a+)+" } }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.fields).toHaveLength(1);
    expect(json.fields[0].field).toBe("config.pattern");
    expect(json.fields[0].code).toBe("INVALID_FORMAT");
  });

  it("returns 422 when the engine throws SYSTEM_FIELD_IMMUTABLE", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockUpdateEntityField.mockRejectedValue(
      new EntityError("SYSTEM_FIELD_IMMUTABLE", { fieldId: FIELD_ID }),
    );

    const res = await makeApp().request(`/${FIELD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "New label" }),
    });

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("SYSTEM_FIELD_IMMUTABLE");
  });

  it("returns 404 when the field does not exist", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockUpdateEntityField.mockRejectedValue(
      new EntityError("FIELD_NOT_FOUND", { fieldId: FIELD_ID }),
    );

    const res = await makeApp().request(`/${FIELD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "New label" }),
    });

    expect(res.status).toBe(404);
  });

  it("passes tenantId, typeId, fieldId, and input through to the engine", async () => {
    mockUpdateEntityField.mockResolvedValue(makeField());

    await makeApp().request(`/${FIELD_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRequired: true, sortOrder: 3 }),
    });

    expect(mockUpdateEntityField).toHaveBeenCalledWith(
      {}, // db
      "t-aaa", // tenantId from auth
      "", // typeId — empty string because no parent router param in unit test
      FIELD_ID,
      { isRequired: true, sortOrder: 3 },
    );
  });
});
