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
}));

// mockUpdateReturns models the UPDATE...RETURNING result — empty means the
// WHERE guard matched 0 rows (either no installation exists for this tenant,
// or it was already in the requested state — both collapse to the same 404,
// mirroring api-keys/delete.ts's soft-revoke idiom exactly).
let mockUpdateReturns: unknown[] = [
  { connectorId: "conn-1", disabledAt: new Date(), disabledBy: "u-bbb" },
];
const mockUpdateWhere = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      update: () => ({
        set: () => ({
          where: (...args: unknown[]) => {
            mockUpdateWhere(...args);
            return { returning: () => Promise.resolve(mockUpdateReturns) };
          },
        }),
      }),
    };
    return fn(tx);
  },
  connectorCredentials: {
    tenantId: "tenantId",
    connectorId: "connectorId",
    disabledAt: "disabledAt",
    disabledBy: "disabledBy",
  },
  connectorInstallationFilter: (tenantId: string, connectorId: string) => ({
    op: "connectorInstallationFilter",
    tenantId,
    connectorId,
  }),
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

const { setConnectorDisabledHandler } = await import("./set-disabled.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.patch("/:connectorId/disabled", ...setConnectorDisabledHandler);
  return app;
}

const CONNECTOR_ID = "aaaaaaaa-0000-4000-a000-000000000001";

function patchDisabled(disabled: boolean) {
  return makeApp().request(`/${CONNECTOR_ID}/disabled`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disabled }),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /connectors/:connectorId/disabled (issue #367)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateReturns = [
      {
        connectorId: CONNECTOR_ID,
        disabledAt: new Date(),
        disabledBy: "u-bbb",
      },
    ];
  });

  it("disables an enabled installation and writes an audit entry", async () => {
    const res = await patchDisabled(true);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.disabled).toBe(true);
    expect(json.data.connectorId).toBe(CONNECTOR_ID);

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0]?.[1];
    expect(entry.resourceType).toBe("connector_installation");
    expect(entry.action).toBe("updated");
    expect(entry.beforeSnapshot).toEqual({ disabled: false });
    expect(entry.afterSnapshot).toEqual({ disabled: true });
  });

  it("performs a single atomic UPDATE guarded by the row's prior state — no separate SELECT", async () => {
    await patchDisabled(true);
    // Exactly one where() call means one statement, not a SELECT followed
    // by an UPDATE — the TOCTOU-race the security review flagged is gone
    // by construction, not just by convention.
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
  });

  it("re-enables a disabled installation", async () => {
    mockUpdateReturns = [
      { connectorId: CONNECTOR_ID, disabledAt: null, disabledBy: null },
    ];

    const res = await patchDisabled(false);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.disabled).toBe(false);

    const entry = mockWriteAuditEntry.mock.calls[0]?.[1];
    expect(entry.beforeSnapshot).toEqual({ disabled: true });
    expect(entry.afterSnapshot).toEqual({ disabled: false });
  });

  it("returns 404 without writing an audit entry when no installation exists for this tenant", async () => {
    mockUpdateReturns = [];

    const res = await patchDisabled(true);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("NOT_FOUND");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns the same 404 for an idempotent re-disable — the WHERE guard matches 0 rows either way", async () => {
    // Already disabled; requesting disabled:true again matches 0 rows under
    // the isNull(disabledAt) guard, indistinguishable from "doesn't exist" —
    // an accepted tradeoff mirroring delete.ts's own "already revoked" 404.
    mockUpdateReturns = [];

    const res = await patchDisabled(true);
    expect(res.status).toBe(404);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean body", async () => {
    const res = await makeApp().request(`/${CONNECTOR_ID}/disabled`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-uuid connectorId", async () => {
    const res = await makeApp().request("/not-a-uuid/disabled", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(res.status).toBe(400);
  });
});
