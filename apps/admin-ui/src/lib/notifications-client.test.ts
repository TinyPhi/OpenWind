import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchWithAuth = vi.fn();

vi.mock("./api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock("../authProvider.js", () => ({
  userManager: { getUser: vi.fn() },
}));

const { listNotifications, markNotificationRead, markAllNotificationsRead } =
  await import("./notifications-client.js");

describe("listNotifications", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it("requests the default page size and no cursor on first load", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: [], nextCursor: null });
    await listNotifications();
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/notifications?limit=10",
    );
  });

  it("includes the cursor when loading a subsequent page", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: [], nextCursor: null });
    await listNotifications("2026-01-01T00:00:00.000Z_abc");
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/notifications?limit=10&cursor=2026-01-01T00%3A00%3A00.000Z_abc",
    );
  });
});

describe("markNotificationRead", () => {
  it("POSTs to the per-notification read endpoint", async () => {
    mockFetchWithAuth.mockResolvedValue({});
    await markNotificationRead("notif-1");
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/notifications/notif-1/read",
      { method: "POST" },
    );
  });
});

describe("markAllNotificationsRead", () => {
  it("POSTs to the bulk mark-all-read endpoint", async () => {
    mockFetchWithAuth.mockResolvedValue({});
    await markAllNotificationsRead();
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/notifications/mark-all-read",
      { method: "POST" },
    );
  });
});
