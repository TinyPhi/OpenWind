/**
 * #1141 (review of #1182) -- the reconcile sweep's SQL, run against real Postgres under
 * withTenantContext. The unit tests mock the query chain, so the 90-day window, the sibling
 * rules, the ordering and RLS were never exercised.
 *
 * Rows are written with the real shapes: a `superset_erasure.failed` row carries `{kind, attempts}`
 * and no `status`, so it counts as terminal.
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
import { createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, tenants, adminAuditLog } from "@platform/db";

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(function () {
    return {
      add: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { enqueue, getJob } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock("../../src/queues.js", () => ({
  connection: {},
  supersetErasureQueue: { getJob },
}));
vi.mock("../../src/superset-erasure.js", () => ({
  enqueueSupersetErasure: enqueue,
  supersetErasureJobId: vi.fn().mockReturnValue("job"),
}));

const { reconcileTenantSupersetErasure } =
  await import("../../src/superset-erasure-reconcile.js");

const TENANT_A = "ffffffff-c000-4000-a000-0000000011a1";
const TENANT_B = "ffffffff-c000-4000-a000-0000000011b1";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date();
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

type AuditRow = typeof adminAuditLog.$inferInsert;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABELS = new Map<string, string>([
  [TENANT_A, "TENANT_A"],
  [TENANT_B, "TENANT_B"],
]);

/** resource_id is a uuid column: a readable label becomes a stable uuid, and maps back for assertions. */
function rid(label: string): string {
  if (UUID.test(label)) return label;
  const h = createHash("md5").update(label).digest("hex");
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  LABELS.set(id, label);
  return id;
}

function deleted(
  tenantId: string,
  resourceId: string,
  createdAt: Date,
  wasMember = true,
): AuditRow {
  return {
    tenantId,
    actorId: "admin",
    actorType: "user",
    resourceType: "user",
    resourceId: rid(resourceId),
    action: "deleted",
    metadata: { userId: `zitadel-${resourceId}`, wasMember },
    createdAt,
  };
}

function erasure(
  tenantId: string,
  resourceType: "user" | "tenant",
  resourceId: string,
  action: "superset_erasure.completed" | "superset_erasure.failed",
  createdAt: Date,
): AuditRow {
  return {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType,
    resourceId: rid(resourceId),
    action,
    metadata: { kind: resourceType, attempts: 1 },
    createdAt,
  };
}

function purged(tenantId: string, createdAt: Date): AuditRow {
  return {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: "tenant",
    resourceId: tenantId,
    action: "purge.completed",
    metadata: {},
    createdAt,
  };
}

async function reset(): Promise<void> {
  await db
    .delete(adminAuditLog)
    .where(inArray(adminAuditLog.tenantId, [TENANT_A, TENANT_B]));
}

async function seed(...rows: AuditRow[]): Promise<void> {
  await db.insert(adminAuditLog).values(rows);
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values([
      { id: TENANT_A, name: "reconcile A", slug: `reconcile-a-${Date.now()}` },
      { id: TENANT_B, name: "reconcile B", slug: `reconcile-b-${Date.now()}` },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await reset();
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

beforeEach(async () => {
  await reset();
  enqueue.mockReset().mockResolvedValue(true);
  getJob.mockReset().mockResolvedValue(undefined);
});

const hashes = (entries: { subjectHash: string }[]): string[] =>
  entries.map((e) => LABELS.get(e.subjectHash) ?? e.subjectHash);

describe("how long an open erasure stays visible (#1141 M2)", () => {
  it("lists a row at 29 and 60 days, drops one past the 90-day window, and keeps created_at", async () => {
    await seed(
      deleted(TENANT_A, "d29", ago(29 * DAY)),
      deleted(TENANT_A, "d60", ago(60 * DAY)),
      deleted(TENANT_A, "d100", ago(100 * DAY)),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);

    expect(hashes(result.entries)).toEqual(["d60", "d29"]);
    expect(result.entries[0]?.createdAt).toBe(ago(60 * DAY).getTime());
    expect(result.olderThan1h).toBe(2);
  });

  it("keeps re-enqueuing a row that is past the 30-day target", async () => {
    await seed(deleted(TENANT_A, "late", ago(45 * DAY)));

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);

    expect(result.reconciled).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      { kind: "user", tenantId: TENANT_A, subject: "zitadel-late" },
      {},
    );
  });

  it("returns the oldest first and does not list a row younger than an hour", async () => {
    await seed(
      deleted(TENANT_A, "mid", ago(3 * DAY)),
      deleted(TENANT_A, "newest", ago(2 * HOUR)),
      deleted(TENANT_A, "oldest", ago(20 * DAY)),
      deleted(TENANT_A, "fresh", ago(10 * 60 * 1000)),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);

    expect(hashes(result.entries)).toEqual(["oldest", "mid", "newest"]);
    expect(result.reconciled).toBe(4);
  });
});

describe("what counts as done (#1141 M3, G2)", () => {
  it("drops a row once its own completed record exists", async () => {
    await seed(
      deleted(TENANT_A, "done", ago(2 * DAY)),
      erasure(TENANT_A, "user", "done", "superset_erasure.completed", ago(DAY)),
      deleted(TENANT_A, "open", ago(2 * DAY)),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);
    expect(hashes(result.entries)).toEqual(["open"]);
  });

  it("keeps a terminally failed row in the entries but never re-enqueues it", async () => {
    await seed(
      deleted(TENANT_A, "failed", ago(9 * DAY)),
      erasure(
        TENANT_A,
        "user",
        "failed",
        "superset_erasure.failed",
        ago(8 * DAY),
      ),
      deleted(TENANT_A, "retry", ago(9 * DAY)),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);

    expect(hashes(result.entries).sort()).toEqual(["failed", "retry"]);
    expect(result.olderThan1h).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      { kind: "user", tenantId: TENANT_A, subject: "zitadel-retry" },
      {},
    );
  });

  it("does not count a failed row as done when a completed one follows it", async () => {
    await seed(
      deleted(TENANT_A, "recovered", ago(9 * DAY)),
      erasure(
        TENANT_A,
        "user",
        "recovered",
        "superset_erasure.failed",
        ago(8 * DAY),
      ),
      erasure(
        TENANT_A,
        "user",
        "recovered",
        "superset_erasure.completed",
        ago(DAY),
      ),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);
    expect(result.entries).toEqual([]);
  });

  it("lets a later completed tenant erasure close that tenant's earlier user rows, not later ones", async () => {
    await seed(
      deleted(TENANT_B, "before-purge", ago(12 * DAY)),
      deleted(TENANT_B, "after-purge", ago(2 * DAY)),
      erasure(
        TENANT_B,
        "tenant",
        TENANT_B,
        "superset_erasure.completed",
        ago(5 * DAY),
      ),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_B, NOW);
    expect(hashes(result.entries)).toEqual(["after-purge"]);
  });

  it("treats a tenant purge the same way: listed until its own completed row exists", async () => {
    await seed(purged(TENANT_B, ago(3 * DAY)));
    const open = await reconcileTenantSupersetErasure(TENANT_B, NOW);
    expect(hashes(open.entries)).toEqual(["TENANT_B"]);
    expect(enqueue).toHaveBeenCalledWith(
      { kind: "tenant", tenantId: TENANT_B },
      {},
    );

    await seed(
      erasure(
        TENANT_B,
        "tenant",
        TENANT_B,
        "superset_erasure.completed",
        ago(DAY),
      ),
    );
    const done = await reconcileTenantSupersetErasure(TENANT_B, NOW);
    expect(done.entries).toEqual([]);
  });

  it("ignores a user deletion that never reached Superset (wasMember false)", async () => {
    await seed(deleted(TENANT_A, "non-member", ago(3 * DAY), false));

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW);
    expect(result.entries).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("terminally failed rows do not starve the rest (#1141)", () => {
  it("still re-enqueues a newer retryable row when older failed rows fill a batch", async () => {
    await seed(
      deleted(TENANT_A, "f1", ago(20 * DAY)),
      erasure(TENANT_A, "user", "f1", "superset_erasure.failed", ago(19 * DAY)),
      deleted(TENANT_A, "f2", ago(19 * DAY)),
      erasure(TENANT_A, "user", "f2", "superset_erasure.failed", ago(18 * DAY)),
      deleted(TENANT_A, "f3", ago(18 * DAY)),
      erasure(TENANT_A, "user", "f3", "superset_erasure.failed", ago(17 * DAY)),
      deleted(TENANT_A, "retry", ago(2 * DAY)),
    );

    const result = await reconcileTenantSupersetErasure(TENANT_A, NOW, {
      batchLimit: 2,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      { kind: "user", tenantId: TENANT_A, subject: "zitadel-retry" },
      {},
    );
    // Each read is capped at 2: the two oldest failed rows and the retryable one.
    expect(hashes(result.entries)).toEqual(["f1", "f2", "retry"]);
  });
});

describe("tenant isolation of the sweep (ADR-001)", () => {
  it("never reads another tenant's rows, nor lets its completed rows close them", async () => {
    await seed(
      deleted(TENANT_A, "a-open", ago(3 * DAY)),
      deleted(TENANT_B, "b-open", ago(3 * DAY)),
      erasure(
        TENANT_B,
        "user",
        "a-open",
        "superset_erasure.completed",
        ago(DAY),
      ),
      erasure(
        TENANT_B,
        "tenant",
        TENANT_B,
        "superset_erasure.completed",
        ago(DAY),
      ),
    );

    const a = await reconcileTenantSupersetErasure(TENANT_A, NOW);
    const b = await reconcileTenantSupersetErasure(TENANT_B, NOW);

    expect(hashes(a.entries)).toEqual(["a-open"]);
    expect(a.entries.every((e) => e.tenantId === TENANT_A)).toBe(true);
    expect(b.entries).toEqual([]);
  });
});
