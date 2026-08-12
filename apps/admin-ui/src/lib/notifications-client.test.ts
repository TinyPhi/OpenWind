import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetchWithAuth = vi.fn();

vi.mock("./api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockGetUser = vi.fn();
vi.mock("../authProvider.js", () => ({
  userManager: { getUser: mockGetUser },
}));

// Fake WebSocket — the module under test calls `new WebSocket(...)` directly,
// so tests drive the fake's lifecycle (open/close/message) rather than a real
// socket. Every instance is captured in `instances` so a test can grab "the
// most recently constructed socket" to simulate server behavior against it.
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
let instances: FakeWebSocket[] = [];
vi.stubGlobal("WebSocket", FakeWebSocket);

function lastInstance(): FakeWebSocket {
  const ws = instances[instances.length - 1];
  if (!ws) throw new Error("no FakeWebSocket instance was constructed");
  return ws;
}

const {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  subscribeToNotifications,
  subscribeToTicketRoom,
} = await import("./notifications-client.js");

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

  it("percent-encodes the id so a WebSocket-injected path traversal cannot reach other endpoints", async () => {
    mockFetchWithAuth.mockResolvedValue({});
    await markNotificationRead("../../admin/reset");
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/notifications/..%2F..%2Fadmin%2Freset/read",
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

// Flushes the microtask queue so `connect()`'s `await userManager.getUser()`
// resolves before assertions run.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("subscribeToTicketRoom (docs/specs/ticket-live-updates.md)", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    instances = [];
    mockGetUser.mockResolvedValue({ access_token: "tok" });
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("sends subscribe_ticket once the socket is open", async () => {
    const unsubscribe = subscribeToTicketRoom("inst-1", () => {});
    cleanups.push(unsubscribe);
    await flush();
    const ws = lastInstance();
    ws.open();

    expect(
      ws.sent.some(
        (s) =>
          (JSON.parse(s) as { type: string; instanceId: string }).type ===
            "subscribe_ticket" &&
          (JSON.parse(s) as { type: string; instanceId: string }).instanceId ===
            "inst-1",
      ),
    ).toBe(true);
  });

  it("sends unsubscribe_ticket on cleanup", async () => {
    const unsubscribe = subscribeToTicketRoom("inst-2", () => {});
    await flush();
    const ws = lastInstance();
    ws.open();
    ws.sent.length = 0;

    unsubscribe();

    expect(
      ws.sent.some(
        (s) =>
          (JSON.parse(s) as { type: string; instanceId: string }).type ===
          "unsubscribe_ticket",
      ),
    ).toBe(true);
  });

  it("re-sends subscribe_ticket for every active room on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = subscribeToTicketRoom("inst-3", () => {});
      cleanups.push(unsubscribe);
      await flush();
      const firstWs = lastInstance();
      firstWs.open();
      firstWs.sent.length = 0;

      // Simulate a dropped connection — the module schedules a reconnect
      // behind a real setTimeout (backoff), driven here by fake timers.
      firstWs.close();
      await vi.advanceTimersByTimeAsync(1_000);
      // A fresh socket was constructed for the reconnect attempt.
      const secondWs = lastInstance();
      expect(secondWs).not.toBe(firstWs);
      secondWs.open();

      expect(
        secondWs.sent.some(
          (s) =>
            (JSON.parse(s) as { type: string; instanceId: string }).type ===
              "subscribe_ticket" &&
            (JSON.parse(s) as { type: string; instanceId: string })
              .instanceId === "inst-3",
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers a room push only to a handler for that message's instanceId, alongside the bell's notification handler", async () => {
    const roomMessages: unknown[] = [];
    const bellMessages: unknown[] = [];
    const unsubBell = subscribeToNotifications((msg) => bellMessages.push(msg));
    const unsubRoom = subscribeToTicketRoom("inst-4", (msg) =>
      roomMessages.push(msg),
    );
    cleanups.push(unsubBell, unsubRoom);
    await flush();
    const ws = lastInstance();
    ws.open();

    ws.receive({
      type: "comment.created",
      instanceId: "inst-4",
      comment: { id: "c-1", body: "hi", authorId: "u-1", createdAt: "now" },
    });

    expect(roomMessages).toHaveLength(1);
    expect(bellMessages).toHaveLength(1);
    expect(
      (bellMessages[0] as { type: string; instanceId?: string }).instanceId,
    ).toBe("inst-4");
  });

  it("shares one socket between the bell and a ticket room — no second connection is opened", async () => {
    const unsubBell = subscribeToNotifications(() => {});
    await flush();
    expect(instances).toHaveLength(1);

    const unsubRoom = subscribeToTicketRoom("inst-5", () => {});
    cleanups.push(unsubBell, unsubRoom);
    await flush();

    expect(instances).toHaveLength(1);
  });
});
