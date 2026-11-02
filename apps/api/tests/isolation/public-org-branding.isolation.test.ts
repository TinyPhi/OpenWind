/**
 * R13 (docs/specs/multi-org-sandbox.md): the unauthenticated login-page brand lookup, against real
 * Postgres. What matters here is what the database can contradict a mock on: only an active
 * sandbox is ever answered, every other kind of tenant gets the same miss as a key that does not
 * exist, a slug no longer finds anything, and the answer holds nothing but the name and the logo --
 * whatever else sits on the row.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Hono } from "hono";
import type * as PlatformRedis from "@platform/redis";
import { inArray } from "drizzle-orm";
import { db, tenants } from "@platform/db";

// The limiter keys are recorded and answered here, so the test needs no Redis; the real helper
// still builds the key, so the bucket name it asserts is the production one.
const mockCheckRateLimit = vi.fn();
vi.mock("@platform/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformRedis>();
  return {
    ...actual,
    getRedis: () => ({}),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  };
});

const { getOrgBrandingByKeyHandler } =
  await import("../../src/routes/public/org-branding.js");

const STAMP = Date.now();
const ACTIVE = {
  id: "eeeeeeee-0157-4000-e000-0000000001b1",
  slug: `r13-active-${STAMP}`,
  key: "a1b2c3d4e5f60718",
};
const REAL = {
  id: "ffffffff-0157-4000-f000-0000000001b2",
  slug: `r13-real-${STAMP}`,
};
const SUSPENDED = {
  id: "dddddddd-0157-4000-d000-0000000001b3",
  slug: `r13-suspended-${STAMP}`,
  key: "a1b2c3d4e5f60719",
};
const DELETED = {
  id: "cccccccc-0157-4000-c000-0000000001b4",
  slug: `r13-deleted-${STAMP}`,
  key: "a1b2c3d4e5f6071a",
};
const PURGED = {
  id: "bbbbbbbb-0157-4000-b000-0000000001b5",
  slug: `r13-purged-${STAMP}`,
  key: "a1b2c3d4e5f6071b",
};
const ALL_IDS = [ACTIVE.id, REAL.id, SUSPENDED.id, DELETED.id, PURGED.id];
const UNKNOWN_KEY = "00000000000000ff";
const LOGO = "data:image/png;base64,iVBORw0KGgo=";

function makeApp(): Hono {
  const app = new Hono();
  app.get("/org-branding/:key", ...getOrgBrandingByKeyHandler);
  return app;
}

async function lookup(key: string): Promise<Response> {
  return makeApp().request(`/org-branding/${key}`);
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: ACTIVE.id,
        name: "R13 Active Sandbox",
        slug: ACTIVE.slug,
        loginKey: ACTIVE.key,
        isSandbox: true,
        logo: LOGO,
        plan: "premium-marker",
        config: { secret_marker: "must-not-leak" },
        zitadelOrgId: `org-r13-${STAMP}`,
      },
      {
        id: REAL.id,
        name: "R13 Real Customer",
        slug: REAL.slug,
        isSandbox: false,
        logo: LOGO,
      },
      {
        id: SUSPENDED.id,
        name: "R13 Suspended Sandbox",
        slug: SUSPENDED.slug,
        loginKey: SUSPENDED.key,
        isSandbox: true,
        status: "suspended",
        logo: LOGO,
      },
      {
        id: DELETED.id,
        name: "R13 Deleted Sandbox",
        slug: DELETED.slug,
        loginKey: DELETED.key,
        isSandbox: true,
        status: "deleted",
        logo: LOGO,
      },
      {
        id: PURGED.id,
        name: "R13 Purged Sandbox",
        slug: PURGED.slug,
        loginKey: PURGED.key,
        isSandbox: true,
        status: "purged",
      },
    ])
    .onConflictDoNothing();
});

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 29,
    resetAt: 0,
  });
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, ALL_IDS));
});

describe("GET /public/org-branding/:key (public-org-branding, R13)", () => {
  it("answers an active sandbox with exactly its name and logo", async () => {
    const res = await lookup(ACTIVE.key);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["data"]);
    expect(Object.keys(body.data).sort()).toEqual(["logo", "name"]);
    expect(body.data).toEqual({ name: "R13 Active Sandbox", logo: LOGO });
  });

  it("never leaks another column of the row, the key included, whatever it holds", async () => {
    const text = await (await lookup(ACTIVE.key)).text();

    for (const secret of [
      ACTIVE.id,
      ACTIVE.key,
      ACTIVE.slug,
      "premium-marker",
      "must-not-leak",
      `org-r13-${STAMP}`,
      "isSandbox",
      "is_sandbox",
      "status",
      "loginKey",
      "login_key",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it.each([
    ["a suspended sandbox", SUSPENDED.key],
    ["a deleted sandbox", DELETED.key],
    ["a purged sandbox", PURGED.key],
    ["a key that does not exist", UNKNOWN_KEY],
    ["a malformed key", "Not_A_Key!"],
    ["an active sandbox's readable slug", ACTIVE.slug],
    ["a real (non-sandbox) tenant's slug", REAL.slug],
    ["an active sandbox's tenant id", ACTIVE.id],
  ])("answers %s with the one shared miss, uncached", async (_label, key) => {
    const res = await lookup(key);

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "NOT_FOUND",
      message: "Not found",
    });
  });

  it("gives every miss a byte-identical body, so no case can be told from another", async () => {
    const bodies = await Promise.all(
      [
        SUSPENDED.key,
        DELETED.key,
        PURGED.key,
        UNKNOWN_KEY,
        "Not_A_Key!",
        ACTIVE.slug,
        REAL.slug,
      ].map(async (key) => (await lookup(key)).text()),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it("does not match a key by prefix or by case", async () => {
    expect((await lookup(ACTIVE.key.slice(0, -1))).status).toBe(404);
    expect((await lookup(ACTIVE.key.toUpperCase())).status).toBe(404);
  });

  it("limits by address in a bucket of its own, never the /auth class sign-in shares", async () => {
    await lookup(ACTIVE.key);

    const key = mockCheckRateLimit.mock.calls[0]?.[1] as string;
    expect(key.startsWith("rl:public-branding:")).toBe(true);
    expect(key).not.toMatch(/:auth$/);
  });

  it("answers 429 and reads nothing once the limit is spent", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: 1,
    });

    const res = await lookup(ACTIVE.key);

    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toContain("R13 Active Sandbox");
  });
});
