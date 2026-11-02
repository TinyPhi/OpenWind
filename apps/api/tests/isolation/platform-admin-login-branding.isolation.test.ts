/**
 * R13 (docs/specs/multi-org-sandbox.md), migration 0162. Real Postgres: the sandbox's login key and
 * what may touch it are database properties, so they are tested against the database -- format,
 * uniqueness, sandbox-only, the backfill, and what platform_admin_role may read and change (the key,
 * yes; the slug, no longer; neither is writable).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, tenants, withPlatformAdminContext } from "@platform/db";

const SANDBOX = "eeeeeeee-0157-4000-e000-0000000001a1";
const OTHER_SANDBOX = "eeeeeeee-0157-4000-e000-0000000001a2";
const REAL = "ffffffff-0157-4000-f000-0000000001a3";
const OLD_SANDBOX_A = "eeeeeeee-0157-4000-e000-0000000001a4";
const OLD_SANDBOX_B = "eeeeeeee-0157-4000-e000-0000000001a5";
const ALL_IDS = [SANDBOX, OTHER_SANDBOX, REAL, OLD_SANDBOX_A, OLD_SANDBOX_B];
const STAMP = Date.now();
const KEY = "0123456789abcdef";

// Drizzle wraps the driver error; the Postgres message is on `cause`.
function errorText(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  return `${String(err)} ${cause instanceof Error ? cause.message : ""}`;
}

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return errorText(err);
  }
  return "";
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: SANDBOX,
        name: "R13 key sandbox",
        slug: `r13-key-${STAMP}`,
        isSandbox: true,
        loginKey: KEY,
      },
      {
        id: OTHER_SANDBOX,
        name: "R13 other sandbox",
        slug: `r13-other-${STAMP}`,
        isSandbox: true,
      },
      { id: REAL, name: "R13 real tenant", slug: `r13-real-${STAMP}` },
      // Sandboxes created before the migration have no key until it backfills them.
      {
        id: OLD_SANDBOX_A,
        name: "R13 old sandbox A",
        slug: `r13-old-a-${STAMP}`,
        isSandbox: true,
      },
      {
        id: OLD_SANDBOX_B,
        name: "R13 old sandbox B",
        slug: `r13-old-b-${STAMP}`,
        isSandbox: true,
      },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, ALL_IDS));
});

describe("tenants.login_key (login-key, R13)", () => {
  it.each([
    ["uppercase hex", "0123456789ABCDEF"],
    ["too short", "0123456789abcde"],
    ["too long", "0123456789abcdef0"],
    ["a non-hex letter", "0123456789abcdeg"],
    ["a dash", "01234567-89abcde"],
    ["a readable slug", "acme-demo-4821"],
  ])("rejects a key that is %s", async (_label, loginKey) => {
    const text = await failure(() =>
      db.update(tenants).set({ loginKey }).where(eq(tenants.id, OTHER_SANDBOX)),
    );

    expect(text).toMatch(/tenants_login_key_check/);
  });

  it("is unique: two tenants cannot hold the same key", async () => {
    const text = await failure(() =>
      db
        .update(tenants)
        .set({ loginKey: KEY })
        .where(eq(tenants.id, OTHER_SANDBOX)),
    );

    expect(text).toMatch(/tenants_login_key_key/);
  });

  it("can only be held by a sandbox, so a real tenant can never be reached through it", async () => {
    const text = await failure(() =>
      db
        .update(tenants)
        .set({ loginKey: "fedcba9876543210" })
        .where(eq(tenants.id, REAL)),
    );

    expect(text).toMatch(/tenants_login_key_sandbox_only/);
    const [row] = await db
      .select({ loginKey: tenants.loginKey })
      .from(tenants)
      .where(eq(tenants.id, REAL));
    expect(row?.loginKey).toBeNull();
  });

  it("lets any number of tenants hold no key", async () => {
    const rows = await db
      .select({ loginKey: tenants.loginKey })
      .from(tenants)
      .where(inArray(tenants.id, [REAL, OTHER_SANDBOX]));

    expect(rows.every((r) => r.loginKey === null)).toBe(true);
  });

  it("backfills every key-less sandbox with a valid, distinct, random key, and leaves real tenants alone", async () => {
    // The migration's own backfill statement, run on sandboxes that have no key yet.
    await db.execute(sql`
      UPDATE tenants
         SET login_key = substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)
       WHERE is_sandbox AND login_key IS NULL
         AND id IN (${OLD_SANDBOX_A}::uuid, ${OLD_SANDBOX_B}::uuid)
    `);

    const rows = await db
      .select({ id: tenants.id, loginKey: tenants.loginKey })
      .from(tenants)
      .where(inArray(tenants.id, [OLD_SANDBOX_A, OLD_SANDBOX_B, REAL]));
    const byId = new Map(rows.map((r) => [r.id, r.loginKey]));
    const a = byId.get(OLD_SANDBOX_A);
    const b = byId.get(OLD_SANDBOX_B);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(byId.get(REAL)).toBeNull();
  });

  it("is not derived from the slug: the slug does not contain it", async () => {
    const [row] = await db
      .select({
        loginKey: tenants.loginKey,
        slug: tenants.slug,
        name: tenants.name,
      })
      .from(tenants)
      .where(eq(tenants.id, OLD_SANDBOX_A));

    expect(row?.slug).not.toContain(row?.loginKey);
  });
});

describe("platform_admin_role and the login key (login-key, R13)", () => {
  it("can read a sandbox's login key", async () => {
    const [row] = await withPlatformAdminContext((tx) =>
      tx
        .select({ loginKey: tenants.loginKey })
        .from(tenants)
        .where(eq(tenants.id, SANDBOX)),
    );

    expect(row?.loginKey).toBe(KEY);
  });

  it.each([
    ["slug", sql`SELECT slug FROM tenants WHERE id = ${SANDBOX}::uuid`],
    ["config", sql`SELECT config FROM tenants WHERE id = ${SANDBOX}::uuid`],
    ["plan", sql`SELECT plan FROM tenants WHERE id = ${SANDBOX}::uuid`],
    [
      "zitadel_org_id",
      sql`SELECT zitadel_org_id FROM tenants WHERE id = ${SANDBOX}::uuid`,
    ],
  ])("cannot read tenants.%s", async (_column, query) => {
    const text = await failure(() =>
      withPlatformAdminContext((tx) => tx.execute(query)),
    );

    expect(text).toMatch(/permission denied/);
  });

  it("cannot change a login key, so a handed-over link cannot be altered from here", async () => {
    const text = await failure(() =>
      withPlatformAdminContext((tx) =>
        tx
          .update(tenants)
          .set({ loginKey: "fedcba9876543210" })
          .where(eq(tenants.id, SANDBOX)),
      ),
    );

    expect(text).toMatch(/permission denied/);
    const [row] = await db
      .select({ loginKey: tenants.loginKey })
      .from(tenants)
      .where(eq(tenants.id, SANDBOX));
    expect(row?.loginKey).toBe(KEY);
  });

  it("cannot set a key on a tenant that has none", async () => {
    const text = await failure(() =>
      withPlatformAdminContext((tx) =>
        tx
          .update(tenants)
          .set({ loginKey: "fedcba9876543210" })
          .where(eq(tenants.id, OTHER_SANDBOX)),
      ),
    );

    expect(text).toMatch(/permission denied/);
  });
});
