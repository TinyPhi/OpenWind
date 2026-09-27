/**
 * #635 / docs/specs/gdpr-erasure-coverage.md R1–R2: a tenant purge must complete
 * for a tenant holding a row in EVERY tenant-scoped table, leave nothing behind
 * except documented exemptions, and never touch another tenant.
 *
 * The seed fixture is checked against information_schema before purging, so a
 * new tenant table that the fixture doesn't populate fails here first — that
 * keeps this test honest as the schema grows.
 *
 * Real Postgres, only BullMQ mocked (same convention as tenant-purge.isolation.test.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, tenants, adminAuditLog } from "@platform/db";

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const PURGED = "aaaaaaaa-0635-4000-a000-000000000001";
const BYSTANDER = "bbbbbbbb-0635-4000-b000-000000000002";
const USER = "u-purge-coverage";

// Seeded but not expected to be emptied by the purge — loaded from the purge
// module's own ERASURE_EXEMPT_TABLES so the two can't drift.
let exemptAfterPurge: Set<string>;
// Not seeded here — needs a real plugin schema; covered by
// tenant-purge-plugin-data.isolation.test.ts.
const NOT_SEEDED = new Set(["installed_plugins"]);

const SEED = readFileSync(
  join(__dirname, "fixtures", "seed-every-tenant-table.sql"),
  "utf8",
);

async function tenantTables(): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
      AND table_name IN (
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      )
    ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}

async function rowCounts(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await tenantTables()) {
    // table names come from information_schema, not user input
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`,
    );
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

async function seed(tenantId: string, status: string): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: tenantId,
      name: `#635 purge coverage ${tenantId}`,
      slug: `purge-coverage-${tenantId}`,
      status,
    })
    .onConflictDoNothing();
  await db.execute(
    sql.raw(
      SEED.replaceAll("__TENANT__", tenantId).replaceAll("__USER__", USER),
    ),
  );
}

async function runPurge(tenantId: string): Promise<void> {
  if (!capturedProcessor) throw new Error("purge processor was not captured");
  await capturedProcessor({ id: `job-${tenantId}`, data: { tenantId } });
}

let bystanderBefore: Record<string, number>;

beforeAll(async () => {
  const purge = await import("../../src/tenant-purge.js");
  exemptAfterPurge = new Set(Object.keys(purge.ERASURE_EXEMPT_TABLES));
  await seed(PURGED, "deleted");
  await seed(BYSTANDER, "active");
  bystanderBefore = await rowCounts(BYSTANDER);
});

afterAll(async () => {
  // Best-effort cleanup of the bystander (and of PURGED if the purge failed),
  // children first by retrying until every table is empty.
  for (const tenantId of [PURGED, BYSTANDER]) {
    for (let pass = 0; pass < 6; pass++) {
      for (const table of await tenantTables()) {
        await db
          .execute(
            sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => undefined);
      }
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

describe("tenant purge — full table coverage (#635)", () => {
  it("the fixture seeds every tenant-scoped table (fails when a new table is added)", async () => {
    const counts = await rowCounts(PURGED);
    const unseeded = Object.entries(counts)
      .filter(([table, n]) => n === 0 && !NOT_SEEDED.has(table))
      .map(([table]) => table);
    expect(unseeded, "tables missing from seed-every-tenant-table.sql").toEqual(
      [],
    );
  });

  it("completes and leaves no non-exempt row for the purged tenant", async () => {
    await runPurge(PURGED);

    const counts = await rowCounts(PURGED);
    const leftovers = Object.entries(counts)
      .filter(([table, n]) => n > 0 && !exemptAfterPurge.has(table))
      .map(([table, n]) => `${table}=${n}`);
    expect(leftovers, "tables still holding purged-tenant rows").toEqual([]);

    const [tenant] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, PURGED));
    expect(tenant?.status).toBe("purged");
  });

  it("anonymizes, rather than deletes, the purged tenant's audit log", async () => {
    const rows = await db
      .select({ actorId: adminAuditLog.actorId })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, PURGED));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.actorId)).not.toContain(USER);
  });

  it("leaves every row of another tenant untouched", async () => {
    expect(await rowCounts(BYSTANDER)).toEqual(bystanderBefore);
  });

  it("is a no-op when re-run after completing", async () => {
    await expect(runPurge(PURGED)).resolves.toBeUndefined();
  });
});
