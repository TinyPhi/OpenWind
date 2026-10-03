/**
 * #693 / docs/specs/export-audit-trail.md: polling a finished async export
 * through the real route writes export.downloaded for the caller's tenant
 * only, a PII refusal writes export.download_denied, a cross-tenant poll
 * writes nothing anywhere, and migration 0131's CHECK constraint accepts both
 * new actions.
 *
 * Real Postgres; only auth and the BullMQ queue are mocked.
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
import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, tenants, withTenantContext, adminAuditLog } from "@platform/db";
import type { AuthContext } from "@platform/auth";

const TENANT = "aaaaaaaa-0693-4000-a000-000000000001";
const OTHER = "bbbbbbbb-0693-4000-b000-000000000002";
const TYPE_ID = "cccccccc-0693-4000-c000-000000000003";
const URL = "https://s3.example.com/exports/0693.csv";

const mockGetJob = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("../../src/lib/export-queue.js", () => ({
  exportQueue: { getJob: (...args: unknown[]) => mockGetJob(...args) },
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

const { exportsRouter } = await import("../../src/routes/exports/download.js");

function app(
  tenantId: string,
  userId: string,
): Hono<{ Variables: { auth: AuthContext } }> {
  const a = new Hono<{ Variables: { auth: AuthContext } }>();
  a.use("*", async (c, next) => {
    c.set("auth", {
      tenantId,
      userId,
      roles: ["agent"],
      email: "poller@example.com",
    });
    await next();
  });
  a.route("/exports", exportsRouter);
  return a;
}

function completedJob(includePii = false): unknown {
  return {
    data: {
      tenantId: TENANT,
      entityTypeId: TYPE_ID,
      format: "csv",
      requestedBy: "u-requester",
      includePii,
    },
    returnvalue: { downloadUrl: URL },
    getState: () => Promise.resolve("completed"),
  };
}

async function exportRows(
  tenantId: string,
): Promise<Array<{ action: string; actorId: string; metadata: unknown }>> {
  return db
    .select({
      action: adminAuditLog.action,
      actorId: adminAuditLog.actorId,
      metadata: adminAuditLog.metadata,
    })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        like(adminAuditLog.action, "export.%"),
      ),
    )
    .orderBy(adminAuditLog.createdAt);
}

async function clearAudit(): Promise<void> {
  for (const id of [TENANT, OTHER]) {
    await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, id));
  }
}

beforeAll(async () => {
  for (const id of [TENANT, OTHER]) {
    await db
      .insert(tenants)
      .values({ id, name: `#693 ${id}`, slug: `export-download-${id}` })
      .onConflictDoNothing();
  }
});

beforeEach(clearAudit);

afterAll(async () => {
  await clearAudit();
  for (const id of [TENANT, OTHER]) {
    await db.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("export download audit trail (#693)", () => {
  it("a completed poll writes export.downloaded for the caller's tenant only", async () => {
    mockGetJob.mockResolvedValue(completedJob());

    const res = await app(TENANT, "u-requester").request(
      "/exports/job-0693/download",
    );
    expect(res.status).toBe(200);

    const rows = await exportRows(TENANT);
    expect(rows).toEqual([
      {
        action: "export.downloaded",
        actorId: "u-requester",
        metadata: { jobId: "job-0693", format: "csv", mode: "async" },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(URL);

    // Read as the other tenant under RLS (app_user), not through an explicit
    // filter — the polling tenant's row must be invisible.
    const seenByOther = await withTenantContext(OTHER, (tx) =>
      tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(like(adminAuditLog.action, "export.%")),
    );
    expect(seenByOther).toEqual([]);
  });

  it("a PII refusal writes export.download_denied and returns 404", async () => {
    mockGetJob.mockResolvedValue(completedJob(true));

    const res = await app(TENANT, "u-someone-else").request(
      "/exports/job-0693-pii/download",
    );
    expect(res.status).toBe(404);

    expect((await exportRows(TENANT)).map((r) => r.action)).toEqual([
      "export.download_denied",
    ]);
  });

  it("another tenant polling the job gets 404 and no audit row lands anywhere", async () => {
    mockGetJob.mockResolvedValue(completedJob());

    const res = await app(OTHER, "u-attacker").request(
      "/exports/job-0693/download",
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(URL);

    expect(await exportRows(TENANT)).toEqual([]);
    expect(await exportRows(OTHER)).toEqual([]);
  });
});
