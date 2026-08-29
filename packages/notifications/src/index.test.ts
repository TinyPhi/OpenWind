/**
 * index.test.ts — @platform/notifications unit tests
 * All external dependencies (BullMQ, Redis, DB) are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function () {
    return { add: mockQueueAdd, close: mockQueueClose };
  }),
  Worker: vi.fn(),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// sql is used by updateUserPreferences for the jsonb_set expression;
// return a plain tagged-template function so the call succeeds in tests.
const sqlTag = vi.fn(
  (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ sql: strings.join("?"), bindings: values }) as unknown,
);
// Allow sql.raw to be called without throwing
(sqlTag as unknown as Record<string, unknown>).raw = vi.fn((s: string) => s);

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ col: a, val: b })),
  sql: sqlTag,
}));

vi.mock("@platform/db", () => ({
  tenants: { id: "tenants.id", config: "tenants.config" },
}));

const {
  sendNotification,
  getUserPreferences,
  updateUserPreferences,
  seedTemplateCache,
} = await import("./index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRedis(members: string[] = []): Redis {
  return {
    smembers: vi.fn().mockResolvedValue(members),
    sadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

function makeDb(config: Record<string, unknown> = {}) {
  const row = { config };
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

const TENANT_ID = "tenant-abc";
const USER_ID = "user-xyz";

beforeEach(() => {
  vi.clearAllMocks();
  mockQueueAdd.mockResolvedValue({ id: "job-1" });
  mockQueueClose.mockResolvedValue(undefined);
});

// ── sendNotification ──────────────────────────────────────────────────────────

describe("sendNotification", () => {
  it("enqueues a BullMQ job for a valid template", async () => {
    const redis = makeRedis(["ticket.assigned", "ticket.resolved"]);

    await sendNotification(redis, TENANT_ID, USER_ID, "ticket.assigned", {
      ticketId: "t-1",
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        tenantId: TENANT_ID,
        userId: USER_ID,
        templateId: "ticket.assigned",
        payload: { ticketId: "t-1" },
      }),
      expect.any(Object),
    );
    expect(mockQueueClose).toHaveBeenCalled();
  });

  it("passes digestKey to the job payload when provided", async () => {
    const redis = makeRedis(["ticket.assigned"]);

    await sendNotification(
      redis,
      TENANT_ID,
      USER_ID,
      "ticket.assigned",
      { ticketId: "t-2" },
      { digestKey: "digest-group-1" },
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ digestKey: "digest-group-1" }),
      expect.any(Object),
    );
  });

  it("throws TEMPLATE_NOT_FOUND when templateId is unknown and cache is populated", async () => {
    const redis = makeRedis(["ticket.assigned"]); // cache has entries

    await expect(
      sendNotification(redis, TENANT_ID, USER_ID, "unknown.template", {}),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("skips template validation when cache is empty (fail-open on cache miss)", async () => {
    const redis = makeRedis([]); // empty cache

    await sendNotification(redis, TENANT_ID, USER_ID, "any.template", {});

    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it("throws PROVIDER_UNAVAILABLE when BullMQ enqueue fails", async () => {
    const redis = makeRedis([]);
    mockQueueAdd.mockRejectedValue(new Error("Redis connection refused"));

    await expect(
      sendNotification(redis, TENANT_ID, USER_ID, "ticket.assigned", {}),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

// ── seedTemplateCache ─────────────────────────────────────────────────────────

describe("seedTemplateCache", () => {
  it("adds templates to Redis set with TTL", async () => {
    const redis = makeRedis();
    await seedTemplateCache(redis, ["ticket.assigned", "ticket.resolved"]);

    expect(redis.sadd).toHaveBeenCalledWith(
      "platform:novu:known_templates",
      "ticket.assigned",
      "ticket.resolved",
    );
    expect(redis.expire).toHaveBeenCalledWith(
      "platform:novu:known_templates",
      300,
    );
  });

  it("is a no-op when given an empty array", async () => {
    const redis = makeRedis();
    await seedTemplateCache(redis, []);
    expect(redis.sadd).not.toHaveBeenCalled();
  });
});

// ── getUserPreferences ────────────────────────────────────────────────────────

describe("getUserPreferences", () => {
  it("returns default preferences when no preference record exists", async () => {
    const db = makeDb({});

    const prefs = await getUserPreferences(db as never, TENANT_ID, USER_ID);

    expect(prefs.channels.email).toBe(true);
    expect(prefs.channels.inApp).toBe(true);
    expect(prefs.channels.sms).toBe(false);
    expect(prefs.templateOverrides).toEqual({});
  });

  it("returns stored preferences when a record exists", async () => {
    const db = makeDb({
      notif_prefs: {
        [USER_ID]: {
          channels: { email: false, inApp: true, sms: true },
          templateOverrides: {},
        },
      },
    });

    const prefs = await getUserPreferences(db as never, TENANT_ID, USER_ID);

    expect(prefs.channels.email).toBe(false);
    expect(prefs.channels.sms).toBe(true);
  });

  it("returns defaults when tenant is not found", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    const prefs = await getUserPreferences(db as never, TENANT_ID, USER_ID);
    expect(prefs).toEqual(
      expect.objectContaining({ channels: expect.any(Object) }),
    );
  });
});

// ── updateUserPreferences ─────────────────────────────────────────────────────

describe("updateUserPreferences", () => {
  it("merges partial channel updates onto existing preferences", async () => {
    const db = makeDb({
      notif_prefs: {
        [USER_ID]: {
          channels: { email: true, inApp: true, sms: false },
          templateOverrides: {},
        },
      },
    });

    const result = await updateUserPreferences(
      db as never,
      TENANT_ID,
      USER_ID,
      {
        channels: { email: true, inApp: true, sms: true },
      },
    );

    expect(result.channels.sms).toBe(true);
    expect(result.channels.email).toBe(true); // unchanged
  });

  it("persists the merged preferences to the DB", async () => {
    const db = makeDb({});
    await updateUserPreferences(db as never, TENANT_ID, USER_ID, {
      channels: { email: false, inApp: true, sms: false },
      templateOverrides: {},
    });

    expect(db.update).toHaveBeenCalled();
  });
});
