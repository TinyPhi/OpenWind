import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockAuth = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["admin"] as string[],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireIntrospection: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

let mockUpdateReturns: unknown[] = [
  {
    id: "key-1",
    name: "acme-key",
    applicationName: "Acme Helpdesk Sync",
    applicationDescription: "Updated description",
    applicationContactEmail: "ops@acme.example",
  },
];
const mockUpdateSet = vi.fn();
const mockWhere = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      update: () => tx,
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return tx;
      },
      where: (...args: unknown[]) => {
        mockWhere(...args);
        return tx;
      },
      returning: () => Promise.resolve(mockUpdateReturns),
    };
    return fn(tx);
  },
  apiKeys: {
    scopesFormat: "api_keys.scopes_format",
  },
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  isNull: vi.fn((...args: unknown[]) => ({ op: "isNull", args })),
}));

const { updateApiKeyHandler } = await import("./update.js");

function makeApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch("/:id", ...updateApiKeyHandler);
  return app;
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    applicationDescription: "Updated description",
    applicationContactEmail: "ops@acme.example",
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api-keys/:id — description/contact-email only (ADR-012 Phase A PR A5, AC7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateReturns = [
      {
        id: "key-1",
        name: "acme-key",
        applicationName: "Acme Helpdesk Sync",
        applicationDescription: "Updated description",
        applicationContactEmail: "ops@acme.example",
      },
    ];
  });

  it("returns 200 and updates applicationDescription/applicationContactEmail", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(res.status).toBe(200);
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.applicationDescription).toBe("Updated description");
    expect(setArg.applicationContactEmail).toBe("ops@acme.example");
  });

  it("rejects an attempt to change scopes — the schema doesn't accept that field at all", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopes: ["entity:ticket:create"] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an attempt to change the name — the schema doesn't accept that field at all", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed-key" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an attempt to change oidcClientId — the schema doesn't accept that field at all", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oidcClientId: "some-other-client" }),
    });
    expect(res.status).toBe(400);
  });

  it("allows updating just the description alone", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationDescription: "Only description" }),
    });
    expect(res.status).toBe(200);
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg).toEqual({ applicationDescription: "Only description" });
  });

  it("returns 422 when the body is empty", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("returns 400 for a malformed applicationContactEmail", async () => {
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applicationContactEmail: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  it("guards the update with isNull(revokedAt) — a revoked key can't be edited", async () => {
    await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    const [andCall] = mockWhere.mock.calls[0];
    expect(andCall.op).toBe("and");
    expect(andCall.args.some((a: { op: string }) => a.op === "isNull")).toBe(
      true,
    );
  });

  it("guards the update with eq(scopesFormat, 'action') — only action-format keys can be edited", async () => {
    await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    const [andCall] = mockWhere.mock.calls[0];
    expect(andCall.op).toBe("and");
    const hasScopesFormatCheck = andCall.args.some(
      (a: { op: string; args: unknown[] }) =>
        a.op === "eq" &&
        a.args[0] === "api_keys.scopes_format" &&
        a.args[1] === "action",
    );
    expect(hasScopesFormatCheck).toBe(true);
  });

  it("returns 404 when the key doesn't exist, belongs to another tenant, or is revoked", async () => {
    mockUpdateReturns = [];
    const res = await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(res.status).toBe(404);
  });

  it("writes an 'updated' audit entry only when a row was actually changed", async () => {
    await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("updated");
    expect(entry.resourceType).toBe("api_key");
  });

  it("does not write an audit entry on 404", async () => {
    mockUpdateReturns = [];
    await makeApp().request("/key-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
