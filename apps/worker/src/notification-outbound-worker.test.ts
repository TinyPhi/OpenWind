/**
 * notification-outbound-worker.test.ts
 *
 * Unit tests for the two production bugs this PR fixes:
 *  - de-dupe gate: "attempted" must NOT block a BullMQ retry (only "sent" does)
 *  - system.error cascade prevention: a failed system.error handoff must not
 *    re-emit another system.error
 * DB, bullmq, and fetch are fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Capture the processor + "failed" handler passed to Worker ──────────────

let capturedProcessor:
  | ((job: {
      data: { notificationId: string; tenantId: string };
    }) => Promise<void>)
  | undefined;
let capturedFailedHandler:
  | ((
      job:
        | {
            data: { notificationId: string; tenantId: string };
            attemptsMade: number;
            opts: { attempts?: number };
          }
        | undefined,
      err: Error,
    ) => void)
  | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: typeof capturedProcessor,
  ) {
    capturedProcessor = processor;
    return {
      on: vi.fn((event: string, handler: typeof capturedFailedHandler) => {
        if (event === "failed") capturedFailedHandler = handler;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// ── DB mocks ─────────────────────────────────────────────────────────────────

let claimedRows: Array<{ title: string; body: string; link: string | null }>;
let recipientRows: Array<{ userId: string }>;
let failedNotificationRows: Array<{ type: string }>;

const mockReturning = vi.fn(() => Promise.resolve(claimedRows));
const mockUpdateWhere = vi.fn(() => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = vi.fn(() => ({ set: mockSet }));

const mockSelectWhere = vi.fn(() => Promise.resolve(recipientRows));
const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

const tx = { update: mockUpdate, select: mockSelect };

const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

vi.mock("@platform/db", () => ({
  db: { insert: (...args: unknown[]) => mockInsert(...args) },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(tx),
  notifications: {
    id: "id",
    tenantId: "tenantId",
    outboundStatus: "outboundStatus",
    type: "type",
    title: "title",
    body: "body",
    link: "link",
  },
  notificationRecipients: {
    userId: "userId",
    notificationId: "notificationId",
    tenantId: "tenantId",
  },
  outboxEvents: {},
  isTenantActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
  ne: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "ne" })),
}));

vi.mock("@platform/auth", () => ({
  getUserById: vi.fn().mockResolvedValue({ email: "u@example.com" }),
}));

vi.mock("@platform/config", () => ({
  env: {
    NOTIFICATION_SERVICE_URL: "https://outbound.example/hook",
    APP_URL: "https://openwind.example.com",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./queues.js", () => ({ connection: {} }));

await import("./notification-outbound-worker.js");

describe("notification outbound worker: de-dupe gate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    recipientRows = [{ userId: "u-1" }];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips dispatch entirely when already 'sent' (ne outboundStatus 'sent' excludes the row from the claim)", async () => {
    // The claim UPDATE's WHERE includes ne(outboundStatus, "sent") — a
    // notification already sent matches no rows, so .returning() is empty.
    claimedRows = [];

    await capturedProcessor?.({
      data: { notificationId: "n-1", tenantId: "t-1" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still dispatches on retry when status is 'attempted' — must not be treated as a blocking state", async () => {
    // A prior attempt set outboundStatus to "attempted" (not "sent"), so a
    // BullMQ retry of the same job must still match ne(outboundStatus,"sent")
    // and re-claim the row.
    claimedRows = [{ title: "T", body: "B", link: null }];

    await capturedProcessor?.({
      data: { notificationId: "n-2", tenantId: "t-1" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(expect.anything());
    // Two update() calls: the "attempted" claim and the final "sent" update.
    expect(mockUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("includes tenantId in the outbound payload (regression: the external service rejects requests missing it)", async () => {
    claimedRows = [{ title: "T", body: "B", link: null }];

    await capturedProcessor?.({
      data: { notificationId: "n-6", tenantId: "t-6" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentPayload = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentPayload["tenantId"]).toBe("t-6");
  });

  it("resolves a relative notification link to a full URL using APP_URL", async () => {
    claimedRows = [{ title: "T", body: "B", link: "/records/tender1/abc-123" }];

    await capturedProcessor?.({
      data: { notificationId: "n-7", tenantId: "t-7" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentPayload = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentPayload["link"]).toBe(
      "https://openwind.example.com/records/tender1/abc-123",
    );
  });

  it("passes through a null link unchanged", async () => {
    claimedRows = [{ title: "T", body: "B", link: null }];

    await capturedProcessor?.({
      data: { notificationId: "n-8", tenantId: "t-8" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentPayload = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentPayload["link"]).toBeNull();
  });

  it("passes through an already-absolute link unchanged (its own origin wins over APP_URL)", async () => {
    claimedRows = [
      { title: "T", body: "B", link: "https://other-host.example/x" },
    ];

    await capturedProcessor?.({
      data: { notificationId: "n-9", tenantId: "t-9" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sentPayload = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentPayload["link"]).toBe("https://other-host.example/x");
  });
});

describe("notification outbound worker: system.error cascade prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not re-emit system.error when a system.error notification's own handoff fails", async () => {
    failedNotificationRows = [{ type: "system.error" }];
    mockReturning.mockResolvedValueOnce(failedNotificationRows);

    await capturedFailedHandler?.(
      {
        data: { notificationId: "n-3", tenantId: "t-1" },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error("outbound service down"),
    );

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("emits a system.error outbox event when a non-system.error notification permanently fails", async () => {
    failedNotificationRows = [{ type: "entity.assigned" }];
    mockReturning.mockResolvedValueOnce(failedNotificationRows);

    await capturedFailedHandler?.(
      {
        data: { notificationId: "n-4", tenantId: "t-1" },
        attemptsMade: 3,
        opts: { attempts: 3 },
      },
      new Error("outbound service down"),
    );

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t-1",
        eventType: "system.error",
      }),
    );
  });

  it("does not act on a retry that hasn't exhausted its attempts yet", async () => {
    await capturedFailedHandler?.(
      {
        data: { notificationId: "n-5", tenantId: "t-1" },
        attemptsMade: 1,
        opts: { attempts: 3 },
      },
      new Error("transient"),
    );

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
