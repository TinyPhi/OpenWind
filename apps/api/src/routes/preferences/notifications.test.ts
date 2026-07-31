import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import type * as Notifications from "@platform/notifications";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetUserPreferences = vi.fn();
const mockUpdateUserPreferences = vi.fn();

const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn({}),
);

vi.mock("@platform/auth", async (importOriginal) => {
  const real = await importOriginal<typeof Auth>();
  return {
    ...real,
    requireAuth:
      () =>
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", {
          tenantId: "t-aaa",
          userId: "u-bbb",
          roles: ["agent"],
          email: "test@example.com",
        });
        await next();
      },
  };
});

vi.mock("@platform/db", () => ({
  withTenantContext: (...args: unknown[]) =>
    mockWithTenantContext(
      ...(args as Parameters<typeof mockWithTenantContext>),
    ),
}));

vi.mock("@platform/notifications", async (importOriginal) => {
  const real = await importOriginal<typeof Notifications>();
  return {
    ...real,
    getUserPreferences: (...args: unknown[]) => mockGetUserPreferences(...args),
    updateUserPreferences: (...args: unknown[]) =>
      mockUpdateUserPreferences(...args),
  };
});

const { getNotificationPrefsHandler, updateNotificationPrefsHandler } =
  await import("./notifications.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/preferences/notifications", ...getNotificationPrefsHandler);
  app.patch("/preferences/notifications", ...updateNotificationPrefsHandler);
  return app;
}

const fakePrefs = {
  channels: { email: true, inApp: true, sms: false },
  templateOverrides: {},
};

describe("GET /preferences/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the user's notification preferences", async () => {
    mockGetUserPreferences.mockResolvedValue(fakePrefs);

    const res = await makeApp().request("/preferences/notifications");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ channels: { email: true } });
  });

  it("routes the DB query through withTenantContext scoped to the auth tenantId (#254)", async () => {
    mockGetUserPreferences.mockResolvedValue(fakePrefs);

    await makeApp().request("/preferences/notifications");

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-aaa",
      expect.any(Function),
    );
  });
});

describe("PATCH /preferences/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with updated preferences", async () => {
    mockUpdateUserPreferences.mockResolvedValue({
      ...fakePrefs,
      channels: { ...fakePrefs.channels, sms: true },
    });

    const res = await makeApp().request("/preferences/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: { sms: true } }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateUserPreferences).toHaveBeenCalled();
  });

  it("routes the DB update through withTenantContext scoped to the auth tenantId (#254)", async () => {
    mockUpdateUserPreferences.mockResolvedValue(fakePrefs);

    await makeApp().request("/preferences/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channels: { email: false } }),
    });

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-aaa",
      expect.any(Function),
    );
  });
});
