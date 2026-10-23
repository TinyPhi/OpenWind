/**
 * R12 (docs/specs/multi-org-sandbox.md), migration 0155. Real Postgres: sandboxes-only and
 * active-only live in platform_admin_set_sandbox_branding, and the logo type limits live in a
 * CHECK, so both are tested against the database rather than through mocked route tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  tenants,
  platformAdminAuditLog,
  setSandboxBranding,
  withPlatformAdminContext,
} from "@platform/db";

const SANDBOX_TENANT = "eeeeeeee-0155-4000-e000-000000000155";
const REGULAR_TENANT = "ffffffff-0155-4000-f000-000000000155";
const DELETING_SANDBOX = "dddddddd-0155-4000-d000-000000000155";
const ACTOR = "pa-r12-isolation";
const ALL_IDS = [SANDBOX_TENANT, REGULAR_TENANT, DELETING_SANDBOX];
const LOGO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function rowOf(
  id: string,
): Promise<{ name: string; logo: string | null }> {
  const [row] = await db
    .select({ name: tenants.name, logo: tenants.logo })
    .from(tenants)
    .where(eq(tenants.id, id));
  if (!row) throw new Error(`no tenant ${id}`);
  return row;
}

async function auditActions(id: string): Promise<string[]> {
  const rows = await db
    .select({ action: platformAdminAuditLog.action })
    .from(platformAdminAuditLog)
    .where(eq(platformAdminAuditLog.targetTenantId, id));
  return rows.map((r) => r.action);
}

// Drizzle wraps the driver error; the Postgres message is on `cause`.
function errorText(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  return `${String(err)} ${cause instanceof Error ? cause.message : ""}`;
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      {
        id: SANDBOX_TENANT,
        name: "R12 sandbox",
        slug: `r12-sandbox-${Date.now()}`,
        isSandbox: true,
      },
      {
        id: REGULAR_TENANT,
        name: "R12 regular tenant",
        slug: `r12-regular-${Date.now()}`,
      },
      {
        id: DELETING_SANDBOX,
        name: "R12 sandbox being deleted",
        slug: `r12-deleting-${Date.now()}`,
        isSandbox: true,
        status: "deleted",
      },
    ])
    .onConflictDoNothing();
});

beforeEach(async () => {
  await db
    .update(tenants)
    .set({ logo: null })
    .where(inArray(tenants.id, ALL_IDS));
  await db
    .update(tenants)
    .set({ name: "R12 sandbox" })
    .where(eq(tenants.id, SANDBOX_TENANT));
  await db
    .delete(platformAdminAuditLog)
    .where(inArray(platformAdminAuditLog.targetTenantId, ALL_IDS));
});

afterAll(async () => {
  await db
    .delete(platformAdminAuditLog)
    .where(inArray(platformAdminAuditLog.targetTenantId, ALL_IDS));
  await db.delete(tenants).where(inArray(tenants.id, ALL_IDS));
});

describe("platform_admin_set_sandbox_branding (sandbox-branding, R12)", () => {
  it("sets a trimmed name and a logo together, audited", async () => {
    const row = await setSandboxBranding(
      SANDBOX_TENANT,
      { name: "  Acme Demo  ", logo: LOGO },
      ACTOR,
    );

    expect(row).toMatchObject({
      id: SANDBOX_TENANT,
      name: "Acme Demo",
      logo: LOGO,
    });

    expect(await rowOf(SANDBOX_TENANT)).toEqual({
      name: "Acme Demo",
      logo: LOGO,
    });
    expect(await auditActions(SANDBOX_TENANT)).toEqual([
      "sandbox.branding_changed",
    ]);
  });

  it("leaves the logo alone when only the name is given", async () => {
    await setSandboxBranding(SANDBOX_TENANT, { logo: LOGO }, ACTOR);
    await setSandboxBranding(SANDBOX_TENANT, { name: "Renamed" }, ACTOR);

    expect(await rowOf(SANDBOX_TENANT)).toEqual({
      name: "Renamed",
      logo: LOGO,
    });
  });

  it("clears the logo when null is given, keeping the name", async () => {
    await setSandboxBranding(SANDBOX_TENANT, { logo: LOGO }, ACTOR);
    await setSandboxBranding(SANDBOX_TENANT, { logo: null }, ACTOR);

    expect(await rowOf(SANDBOX_TENANT)).toEqual({
      name: "R12 sandbox",
      logo: null,
    });
  });

  it("refuses a regular tenant, leaving it and the audit log untouched", async () => {
    await expect(
      setSandboxBranding(
        REGULAR_TENANT,
        { name: "Hijacked", logo: LOGO },
        ACTOR,
      ),
    ).resolves.toBeNull();

    expect(await rowOf(REGULAR_TENANT)).toEqual({
      name: "R12 regular tenant",
      logo: null,
    });
    expect(await auditActions(REGULAR_TENANT)).toEqual([]);
  });

  it("refuses a sandbox that is no longer active (being deleted)", async () => {
    await expect(
      setSandboxBranding(DELETING_SANDBOX, { name: "Late rename" }, ACTOR),
    ).resolves.toBeNull();

    expect((await rowOf(DELETING_SANDBOX)).name).toBe(
      "R12 sandbox being deleted",
    );
    expect(await auditActions(DELETING_SANDBOX)).toEqual([]);
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name over 100 characters", { name: "x".repeat(101) }],
    ["a request that changes nothing", {}],
  ])("refuses %s and writes no audit row", async (_label, change) => {
    await expect(
      setSandboxBranding(SANDBOX_TENANT, change, ACTOR),
    ).resolves.toBeNull();

    expect((await rowOf(SANDBOX_TENANT)).name).toBe("R12 sandbox");
    expect(await auditActions(SANDBOX_TENANT)).toEqual([]);
  });
});

describe("tenants.logo CHECK (R12)", () => {
  it.each([
    ["an SVG", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["a gif", "data:image/gif;base64,R0lGODlhAQABAAAAACw="],
    ["a plain URL", "https://example.com/logo.png"],
    ["markup in the payload", 'data:image/png;base64,AAAA"><script>'],
    ["an over-long logo", `data:image/png;base64,${"A".repeat(140_001)}`],
  ])("rejects %s", async (_label, logo) => {
    let caught: unknown;
    try {
      await db
        .update(tenants)
        .set({ logo })
        .where(eq(tenants.id, SANDBOX_TENANT));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/tenants_logo_check/);
    expect((await rowOf(SANDBOX_TENANT)).logo).toBeNull();
  });
});

describe("branding privileges (0155)", () => {
  it("gives platform_admin_role no direct UPDATE on tenants", async () => {
    let caught: unknown;
    try {
      await withPlatformAdminContext((tx) =>
        tx
          .update(tenants)
          .set({ logo: LOGO })
          .where(eq(tenants.id, REGULAR_TENANT)),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/permission denied/);
    expect((await rowOf(REGULAR_TENANT)).logo).toBeNull();
  });

  it("lets platform_admin_role read the logo column", async () => {
    await setSandboxBranding(SANDBOX_TENANT, { logo: LOGO }, ACTOR);

    const [row] = await withPlatformAdminContext((tx) =>
      tx
        .select({ logo: tenants.logo })
        .from(tenants)
        .where(eq(tenants.id, SANDBOX_TENANT)),
    );

    expect(row?.logo).toBe(LOGO);
  });

  it("gives app_user no UPDATE on tenants.logo, so a tenant admin cannot set its own brand", async () => {
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .update(tenants)
          .set({ logo: LOGO })
          .where(eq(tenants.id, SANDBOX_TENANT));
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/permission denied/);
    expect((await rowOf(SANDBOX_TENANT)).logo).toBeNull();
  });

  it("lets tenant_lifecycle_role clear a logo, which is how the purge empties the tombstone", async () => {
    await setSandboxBranding(SANDBOX_TENANT, { logo: LOGO }, ACTOR);

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE tenant_lifecycle_role`);
      await tx
        .update(tenants)
        .set({ logo: null })
        .where(eq(tenants.id, SANDBOX_TENANT));
    });

    expect((await rowOf(SANDBOX_TENANT)).logo).toBeNull();
  });

  it("does not let app_user execute the function without SET ROLE platform_admin_role", async () => {
    let caught: unknown;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT platform_admin_set_sandbox_branding(${SANDBOX_TENANT}::uuid, 'x', NULL, false)`,
        );
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(errorText(caught)).toMatch(/permission denied for function/);
  });
});
