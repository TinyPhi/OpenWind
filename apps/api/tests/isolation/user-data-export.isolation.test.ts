/**
 * #642 / docs/specs/user-data-export.md against real Postgres as app_user.
 *
 * - the collector returns the subject's rows (including saved_views behind the
 *   app.user_id GUC) and never another tenant's, and no secret value;
 * - POST /users/:userId/export is tenant-scoped: another tenant's admin gets 404;
 * - an agent cannot download a user_data export, through the entity-export
 *   route or the admin route; the denial is audited.
 *
 * Only auth (roles are really checked) and the BullMQ queue are replaced.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  tenants,
  tenantUsers,
  entityInstances,
  adminAuditLog,
  withTenantAndUserContext,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import type * as FilesModule from "@platform/files";
import {
  collectUserDataBundle,
  serializeUserDataBundle,
} from "@platform/entity-engine";

const TENANT = "aaaaaaaa-0642-4000-a000-0000000000e1";
const OTHER_TENANT = "bbbbbbbb-0642-4000-b000-0000000000e2";
const SUBJECT = "u-export-subject";
const ONLY_IN_A = "u-only-in-tenant-a";
const ADMIN = "u-export-admin";

const SEED = readFileSync(
  join(
    __dirname,
    "../../../worker/tests/isolation/fixtures/seed-every-tenant-table.sql",
  ),
  "utf8",
);

const jobs = new Map<string, Record<string, unknown>>();
const mockAdd = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireRole:
    (...roles: string[]) =>
    async (c: Context, next: Next) => {
      const auth = c.get("auth") as AuthContext;
      if (!auth.roles.some((r) => roles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      await next();
      return;
    },
}));

vi.mock("../../src/lib/export-queue.js", () => ({
  exportQueue: {
    add: (name: string, data: unknown, opts: { jobId: string }) => {
      mockAdd(name, data, opts);
      jobs.set(opts.jobId, {
        data,
        returnvalue: {
          storageKey: `${(data as { tenantId: string }).tenantId}/exports/${opts.jobId}.json`,
        },
        finishedOn: Date.now(),
        getState: () => Promise.resolve("completed"),
      });
      return Promise.resolve({ id: opts.jobId });
    },
    getJob: (id: string) => Promise.resolve(jobs.get(id)),
  },
  isUserDataExportPayload: (d: { kind?: string }) => d.kind === "user_data",
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

vi.mock("../../src/lib/rate-limit-tiers.js", () => ({
  enforceExportRateLimit: () => Promise.resolve({ allowed: true, resetAt: 0 }),
}));

const mockGetExportStream = vi.fn();
vi.mock("@platform/files", async (importOriginal) => {
  const actual = await importOriginal<typeof FilesModule>();
  return {
    ...actual,
    getExportStream: (...a: unknown[]) => mockGetExportStream(...a),
  };
});

const { usersRouter } = await import("../../src/routes/platform/users.js");
const { exportsRouter } = await import("../../src/routes/exports/download.js");

function app(
  tenantId: string,
  userId: string,
  roles: string[],
): Hono<{ Variables: { auth: AuthContext } }> {
  const a = new Hono<{ Variables: { auth: AuthContext } }>();
  a.use("*", async (c, next) => {
    c.set("auth", { tenantId, userId, roles, email: "x@example.com" });
    await next();
  });
  a.route("/users", usersRouter);
  a.route("/exports", exportsRouter);
  return a;
}

async function seedTenant(tenantId: string): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: tenantId,
      name: `#642 export ${tenantId}`,
      slug: `user-data-export-${tenantId}`,
    })
    .onConflictDoNothing();
  await db.execute(
    sql.raw(
      SEED.replaceAll("__TENANT__", tenantId).replaceAll("__USER__", SUBJECT),
    ),
  );
}

async function auditRows(
  tenantId: string,
): Promise<Array<{ action: string; resourceType: string }>> {
  return db
    .select({
      action: adminAuditLog.action,
      resourceType: adminAuditLog.resourceType,
    })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        eq(adminAuditLog.resourceType, "user_data_export"),
      ),
    )
    .orderBy(adminAuditLog.createdAt);
}

beforeAll(async () => {
  await seedTenant(TENANT);
  await seedTenant(OTHER_TENANT);
  await db.insert(tenantUsers).values({
    tenantId: TENANT,
    userId: ONLY_IN_A,
    email: "only-a@example.com",
  });
});

beforeEach(async () => {
  jobs.clear();
  vi.clearAllMocks();
  for (const t of [TENANT, OTHER_TENANT]) {
    await db
      .delete(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, t),
          eq(adminAuditLog.resourceType, "user_data_export"),
        ),
      );
  }
});

afterAll(async () => {
  for (const tenantId of [TENANT, OTHER_TENANT]) {
    const tables = await db.execute<{ table_name: string }>(sql`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'`);
    for (let pass = 0; pass < 6; pass++) {
      for (const { table_name } of tables) {
        await db
          .execute(
            sql`DELETE FROM ${sql.identifier(table_name)} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => undefined);
      }
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

describe("collector against real Postgres (#642)", () => {
  async function bundleFor(tenantId: string, rowLimit = 10_000) {
    return withTenantAndUserContext(tenantId, ADMIN, (tx) =>
      collectUserDataBundle(tx, {
        tenantId,
        userId: SUBJECT,
        rowLimit,
        includeAudit: true,
      }),
    );
  }

  it("returns the subject's rows, including saved_views read behind app.user_id", async () => {
    const b = await bundleFor(TENANT);
    expect(b.data.tenantUsers).toHaveLength(1);
    expect(b.data.savedViews).toHaveLength(1);
    expect(b.data.entityInstances?.length).toBeGreaterThan(0);
    expect(b.data.apiKeys).toHaveLength(1);
    expect(b.data.onCallSchedules?.length).toBeGreaterThan(0);
    expect(b.data.orgEmployees).toHaveLength(1);
    expect(b.data.workflowEvents?.length).toBeGreaterThan(0);
  });

  it("never includes another tenant's rows for the same user id", async () => {
    const a = await bundleFor(TENANT);
    const other = await db
      .select({ id: entityInstances.id })
      .from(entityInstances)
      .where(eq(entityInstances.tenantId, OTHER_TENANT));
    const otherIds = new Set(other.map((r) => r.id));
    expect(otherIds.size).toBeGreaterThan(0);
    const ids = (a.data.entityInstances ?? []).map((r) => r.id as string);
    expect(ids.filter((id) => otherIds.has(id))).toEqual([]);
    expect(a.metadata.tenantId).toBe(TENANT);
  });

  it("contains no secret value from the seeded rows", async () => {
    const text = serializeUserDataBundle(await bundleFor(TENANT)).toString(
      "utf-8",
    );
    expect(text).not.toContain(`hash-${TENANT}`);
    expect(text).not.toContain(`h-${TENANT}`);
    expect(text).not.toContain(`${TENANT}/a`);
  });

  it("restores app.user_id after reading saved_views", async () => {
    const after = await withTenantAndUserContext(TENANT, ADMIN, async (tx) => {
      await collectUserDataBundle(tx, {
        tenantId: TENANT,
        userId: SUBJECT,
        rowLimit: 100,
        includeAudit: false,
      });
      const [row] = await tx.execute<{ v: string }>(
        sql`SELECT current_setting('app.user_id', true) AS v`,
      );
      return row?.v;
    });
    expect(after).toBe(ADMIN);
  });

  it("records truncation at the row limit", async () => {
    const b = await bundleFor(TENANT, 100);
    expect(b.metadata.truncated).toEqual([]);
    const tiny = await withTenantAndUserContext(TENANT, ADMIN, (tx) =>
      collectUserDataBundle(tx, {
        tenantId: TENANT,
        userId: SUBJECT,
        rowLimit: 1,
        includeAudit: true,
      }),
    );
    for (const name of tiny.metadata.truncated) {
      expect(tiny.data[name]).toHaveLength(1);
    }
  });
});

describe("POST /users/:userId/export tenant scoping (#642)", () => {
  it("lets a tenant admin export a user of that tenant and audits it", async () => {
    const res = await app(TENANT, ADMIN, ["admin"]).request(
      `/users/${ONLY_IN_A}/export`,
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect((await auditRows(TENANT)).map((r) => r.action)).toEqual([
      "export.requested",
    ]);
  });

  it("returns 404 for another tenant's user, enqueues nothing, audits nothing", async () => {
    const res = await app(OTHER_TENANT, ADMIN, ["admin"]).request(
      `/users/${ONLY_IN_A}/export`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(await auditRows(OTHER_TENANT)).toEqual([]);
    expect(await auditRows(TENANT)).toEqual([]);
  });

  it("refuses an agent", async () => {
    const res = await app(TENANT, "u-agent", ["agent"]).request(
      `/users/${ONLY_IN_A}/export`,
      { method: "POST" },
    );
    expect(res.status).toBe(403);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("user_data download access (#642)", () => {
  async function requestExport(): Promise<string> {
    const res = await app(TENANT, ADMIN, ["admin"]).request(
      `/users/${ONLY_IN_A}/export`,
      { method: "POST" },
    );
    return ((await res.json()) as { data: { jobId: string } }).data.jobId;
  }

  it("an agent gets 404 from the entity-export route and the denial is audited", async () => {
    const jobId = await requestExport();
    const res = await app(TENANT, "u-agent", ["agent"]).request(
      `/exports/${jobId}/download?file=1`,
    );
    expect(res.status).toBe(404);
    expect(mockGetExportStream).not.toHaveBeenCalled();
    expect((await auditRows(TENANT)).map((r) => r.action)).toEqual([
      "export.requested",
      "export.download_denied",
    ]);
  });

  it("an agent gets 403 from the admin download route", async () => {
    const jobId = await requestExport();
    const res = await app(TENANT, "u-agent", ["agent"]).request(
      `/users/${ONLY_IN_A}/export/${jobId}/download?file=1`,
    );
    expect(res.status).toBe(403);
    expect(mockGetExportStream).not.toHaveBeenCalled();
  });

  it("even an admin cannot fetch it through the entity-export route", async () => {
    const jobId = await requestExport();
    const res = await app(TENANT, ADMIN, ["admin"]).request(
      `/exports/${jobId}/download?file=1`,
    );
    expect(res.status).toBe(404);
  });

  it("another tenant's admin gets 404 from the admin download route", async () => {
    const jobId = await requestExport();
    const res = await app(OTHER_TENANT, ADMIN, ["admin"]).request(
      `/users/${ONLY_IN_A}/export/${jobId}/download?file=1`,
    );
    expect(res.status).toBe(404);
    expect(mockGetExportStream).not.toHaveBeenCalled();
    expect(await auditRows(OTHER_TENANT)).toEqual([]);
  });

  it("the requesting tenant's admin downloads it and the download is audited", async () => {
    const { Readable } = await import("node:stream");
    mockGetExportStream.mockResolvedValue({
      stream: Readable.from([Buffer.from("{}")]),
      mimeType: "application/json",
      originalName: "export.json",
      sizeBytes: 2,
    });
    const jobId = await requestExport();
    const res = await app(TENANT, ADMIN, ["admin"]).request(
      `/users/${ONLY_IN_A}/export/${jobId}/download?file=1`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
    expect((await auditRows(TENANT)).map((r) => r.action)).toEqual([
      "export.requested",
      "export.downloaded",
    ]);
  });
});
