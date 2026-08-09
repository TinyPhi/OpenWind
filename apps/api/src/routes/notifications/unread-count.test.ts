import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

vi.mock("drizzle-orm", () => {
  const noop = vi.fn(() => "sql");
  return { eq: noop, and: noop, isNull: noop, count: noop };
});

const mockWithTenantAndUserContext = vi.fn();

vi.mock("@platform/db", () => {
  const col = (name: string) => name;
  const tbl = (cols: string[]) =>
    Object.fromEntries(cols.map((c) => [c, col(c)]));
  return {
    db: {},
    withTenantAndUserContext: (...args: unknown[]) =>
      mockWithTenantAndUserContext(...args),
    notificationRecipients: tbl(["tenantId", "userId", "readAt"]),
  };
});

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", {
        tenantId: "tenant-aaa",
        userId: "user-bbb",
        roles: ["user"],
      } as AuthContext);
      return next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: unknown, next: () => Promise<void>) =>
      next(),
}));

const { unreadNotificationCountHandler } = await import("./unread-count.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/unread-count", ...unreadNotificationCountHandler);
  return app;
}

describe("GET /notifications/unread-count", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the count from the tenant+user scoped query", async () => {
    mockWithTenantAndUserContext.mockResolvedValueOnce([{ count: 4 }]);

    const res = await makeApp().request("/unread-count");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual({ count: 4 });
    expect(mockWithTenantAndUserContext).toHaveBeenCalledWith(
      "tenant-aaa",
      "user-bbb",
      expect.any(Function),
    );
  });

  it("returns 0 when the query returns no row", async () => {
    mockWithTenantAndUserContext.mockResolvedValueOnce([]);

    const res = await makeApp().request("/unread-count");
    const { data } = await res.json();
    expect(data).toEqual({ count: 0 });
  });
});
