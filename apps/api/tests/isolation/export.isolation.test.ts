/**
 * Isolation tests for the entity export feature.
 *
 * Section 1 — DB-level RLS: verifies that Tenant A's export cannot return
 * rows owned by Tenant B (enforced by listEntities used in both sync and
 * async export paths).
 *
 * Section 2 — HTTP download access control: verifies that the polling
 * endpoint rejects cross-tenant job access and within-tenant low-privilege
 * polling of PII exports. These tests use a mocked queue (no Redis needed)
 * and rely on requireAuth's pre-populated auth short-circuit.
 *
 * Tests in section 1 run against a real Postgres instance (no mocks).
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
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, withTenantContext } from "@platform/db";
import { adminAuditLog, entityInstances, entityTypes } from "@platform/db";
import {
  createEntityType,
  createEntity,
  type EntityType,
  type EntityInstance,
} from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";

// ── Queue mock (section 2 only — no Redis required) ───────────────────────────

const mockGetJob = vi.fn();

vi.mock("../../src/lib/export-queue.js", () => ({
  exportQueue: { getJob: (...args: unknown[]) => mockGetJob(...args) },
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

const { exportsRouter } = await import("../../src/routes/exports/download.js");

const TENANT_A = "aaaaaaaa-3333-4000-a000-000000000031";
const TENANT_B = "bbbbbbbb-3333-4000-b000-000000000032";

beforeEach(() => vi.clearAllMocks());

let entityType: EntityType;
let instanceA: EntityInstance;
let instanceB: EntityInstance;

beforeAll(async () => {
  entityType = await createEntityType(db, null, {
    name: `export_isolation_type_${Date.now()}`,
    plural: "export_isolation_records",
    allowCustomFields: false,
  });

  instanceA = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId: entityType.id,
      fields: { label: "Tenant A record" },
    }),
  );

  instanceB = await withTenantContext(TENANT_B, (tx) =>
    createEntity(tx, TENANT_B, {
      entityTypeId: entityType.id,
      fields: { label: "Tenant B record" },
    }),
  );
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityType.id));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityType.id));
  // #693: polling a completed or PII-refused job now writes audit rows.
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_A));
});

describe("entity export — cross-tenant row isolation", () => {
  it("Tenant A context cannot read Tenant B instance via direct query", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const { listEntities } = await import("@platform/entity-engine");
      const page = await listEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
        limit: 100,
      });
      const ids = page.data.map((r) => r.id);
      expect(ids).toContain(instanceA.id);
      expect(ids).not.toContain(instanceB.id);
    });
  });

  it("Tenant B context cannot read Tenant A instance", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const { listEntities } = await import("@platform/entity-engine");
      const page = await listEntities(tx, TENANT_B, {
        entityTypeId: entityType.id,
        limit: 100,
      });
      const ids = page.data.map((r) => r.id);
      expect(ids).toContain(instanceB.id);
      expect(ids).not.toContain(instanceA.id);
    });
  });

  it("entity count for Tenant A is exactly 1 (no cross-tenant leak)", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const { listEntities } = await import("@platform/entity-engine");
      const page = await listEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
        limit: 100,
      });
      expect(page.data).toHaveLength(1);
    });
  });
});

// ── Section 2: download polling access control ────────────────────────────────

function makeDownloadApp(
  tenantId: string,
  userId: string,
  roles: string[],
): Hono {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  // Pre-populate auth context — requireAuth short-circuits when auth is present
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId, userId, roles, email: "test@example.com" });
      await next();
    },
  );
  app.route("/exports", exportsRouter);
  return app;
}

function makeQueueJob(opts: {
  tenantId: string;
  requestedBy: string;
  includePii: boolean;
  returnvalue?: Record<string, unknown>;
}): unknown {
  return {
    data: {
      tenantId: opts.tenantId,
      entityTypeId: entityType.id,
      format: "csv",
      requestedBy: opts.requestedBy,
      includePii: opts.includePii,
    },
    returnvalue: opts.returnvalue,
    getState: vi.fn().mockResolvedValue("completed"),
  };
}

describe("GET /exports/:jobId/download — polling access control", () => {
  it("returns 404 when a tenant polls a job that belongs to a different tenant", async () => {
    mockGetJob.mockResolvedValue(
      makeQueueJob({
        tenantId: TENANT_A,
        requestedBy: "u-aaa",
        includePii: false,
        returnvalue: {
          storageKey: `${TENANT_A}/exports/job-tenant-a.csv`,
          format: "csv",
        },
      }),
    );

    // Tenant B attempts to poll a job owned by Tenant A
    const res = await makeDownloadApp(TENANT_B, "u-bbb", ["agent"]).request(
      "/exports/job-tenant-a/download",
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 404 when an agent polls another user's PII export without the pii_export role", async () => {
    mockGetJob.mockResolvedValue(
      makeQueueJob({
        tenantId: TENANT_A,
        requestedBy: "u-aaa",
        includePii: true,
        returnvalue: {
          storageKey: `${TENANT_A}/exports/job-pii.csv`,
          format: "csv",
        },
      }),
    );

    // u-bbb is in the same tenant but has no pii_export role and is not the requester
    const res = await makeDownloadApp(TENANT_A, "u-bbb", ["agent"]).request(
      "/exports/job-pii/download",
    );

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOT_FOUND");
  });

  it("returns 200 when the original requester polls their own PII export without pii_export role", async () => {
    mockGetJob.mockResolvedValue(
      makeQueueJob({
        tenantId: TENANT_A,
        requestedBy: "u-aaa",
        includePii: true,
        returnvalue: {
          storageKey: `${TENANT_A}/exports/job-pii.csv`,
          format: "csv",
        },
      }),
    );

    const res = await makeDownloadApp(TENANT_A, "u-aaa", ["agent"]).request(
      "/exports/job-pii/download",
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string } };
    expect(json.data.status).toBe("complete");
  });
});
