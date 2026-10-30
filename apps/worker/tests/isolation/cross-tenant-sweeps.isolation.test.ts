/**
 * Issue #1078 -- connector-poll-scheduler, attachment-cleanup and file-cleanup are cross-tenant
 * sweeps. They used to query RLS-protected tables with the plain `db` client and no tenant
 * context, which as app_user either errors (`''::uuid`) or silently sees zero rows. They now
 * enumerate tenants and work inside withTenantContext.
 *
 * The pool is switched to the NOBYPASSRLS app_user role at session start (startup option
 * `-c role=app_user`, set before @platform/db loads), which is how the worker runs in production.
 * The test first proves that role is really in effect, then proves both tenants' rows are
 * processed and that nothing leaks across tenants. Seeding and verification briefly step back up
 * to the login role with SET LOCAL ROLE inside a transaction (see `adminRows`).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";

// Must run before @platform/db is imported: the worker pool is created from this URL.
vi.hoisted(() => {
  const base = (process.env["DATABASE_URL"] as string).split("?")[0];
  // %20 (not +): postgres.js passes the value as a startup parameter without decoding '+'.
  process.env["DATABASE_URL"] = `${base}?options=-c%20role%3Dapp_user`;
});

import { db } from "@platform/db";
import { registerConnector } from "@platform/connector-sdk";
import { runCleanup as runAttachmentCleanup } from "../../src/attachment-cleanup.js";
import { runCleanup as runFileCleanup } from "../../src/file-cleanup.js";
import { reconcile } from "../../src/connector-poll-scheduler.js";

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

// vitest 4.x: mockImplementation must use a regular function (not arrow) when used with `new`.
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

vi.mock("../../src/queues.js", () => ({
  connection: {},
  connectorPollQueue: {
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

vi.mock("node:fs/promises", () => ({
  default: { unlink: vi.fn().mockRejectedValue(new Error("ENOENT")) },
}));

const TENANT_A = "ffffffff-1078-4000-a000-00000000000a";
const TENANT_B = "ffffffff-1078-4000-a000-00000000000b";
const TENANT_IDS = [TENANT_A, TENANT_B];
const CONNECTOR_DEF_ID = "ffffffff-1078-4000-a000-0000000000c1";

const HOUR = 60 * 60 * 1000;
const ago = (ms: number): Date => new Date(Date.now() - ms);

/**
 * Runs raw SQL as the login (superuser) role. The pool's session role is app_user, so
 * RLS-protected tables would otherwise read as empty and refuse test-fixture inserts.
 */
async function adminRows(rawSql: string): Promise<Record<string, unknown>[]> {
  return db.transaction(async (tx) => {
    const [row] = await tx.execute(sql`SELECT session_user AS u`);
    const login = String((row as { u: string }).u).replace(/"/g, '""');
    await tx.execute(sql.raw(`SET LOCAL ROLE "${login}"`));
    return [...(await tx.execute(sql.raw(rawSql)))];
  });
}

async function seedTenant(tenantId: string, tag: string): Promise<void> {
  await adminRows(
    `INSERT INTO tenants (id, name, slug) VALUES ('${tenantId}', 'sweep-1078-${tag}', 'sweep-1078-${tag}-${Date.now()}')`,
  );

  const slot = (
    suffix: string,
    status: string,
    expiresAt: Date,
    updatedAt: Date,
  ): string =>
    `('${tenantId}', 'u', 'u', 'f.txt', 1, 'text/plain', 'hash-${tag}-${suffix}', '${expiresAt.toISOString()}', '${status}', '${updatedAt.toISOString()}')`;
  await adminRows(`INSERT INTO attachments (tenant_id, uploaded_by, acting_person_id,
    declared_filename, declared_size_bytes, declared_mime_type, upload_token_hash,
    upload_expires_at, status, updated_at) VALUES
    ${slot("stale", "pending", ago(HOUR), ago(HOUR))},
    ${slot("stale-uploading", "uploading", ago(HOUR), ago(HOUR))},
    ${slot("old-expired", "expired", ago(5 * HOUR), ago(3 * HOUR))},
    ${slot("fresh", "pending", new Date(Date.now() + HOUR), new Date())}`);

  const file = (suffix: string, scan: string, createdAt: Date): string =>
    `('${tenantId}', 'm', 'n.txt', 'tenants/${tenantId}/files/${suffix}.txt', 'text/plain', 1, '${scan}', 'u', '${createdAt.toISOString()}')`;
  await adminRows(`INSERT INTO files (tenant_id, module_slug, original_name, storage_key,
    mime_type, size_bytes, scan_status, uploaded_by, created_at) VALUES
    ${file("stale-pending", "pending", ago(48 * HOUR))},
    ${file("soft-deleted", "deleted", ago(HOUR))},
    ${file("fresh-pending", "pending", new Date())},
    ${file("clean", "clean", ago(72 * HOUR))}`);

  await adminRows(
    `INSERT INTO connector_credentials (tenant_id, connector_id) VALUES ('${tenantId}', '${CONNECTOR_DEF_ID}')`,
  );
}

async function cleanup(): Promise<void> {
  const ids = TENANT_IDS.map((id) => `'${id}'`).join(", ");
  for (const table of ["attachments", "files", "connector_credentials"]) {
    await adminRows(`DELETE FROM ${table} WHERE tenant_id IN (${ids})`);
  }
  await adminRows(`DELETE FROM tenants WHERE id IN (${ids})`);
  await adminRows(
    `DELETE FROM connector_definitions WHERE id = '${CONNECTOR_DEF_ID}'`,
  );
}

beforeAll(async () => {
  await cleanup();
  await adminRows(`INSERT INTO connector_definitions (id, slug, name, version, category, allowed_hosts)
    VALUES ('${CONNECTOR_DEF_ID}', 'sweep-1078', 'Sweep 1078', '1.0.0', 'other', ARRAY['example.com'])`);
  await seedTenant(TENANT_A, "a");
  await seedTenant(TENANT_B, "b");

  registerConnector({
    meta: {
      id: CONNECTOR_DEF_ID,
      name: "Sweep 1078",
      version: "1.0.0",
      description: "test",
      iconUrl: "https://example.com/icon.png",
      category: "other",
    },
    allowedHosts: ["example.com"],
    auth: { type: "apiKey", headerName: "X-Api-Key", credentialKey: "k" },
    triggers: [
      {
        id: "poll",
        name: "Poll",
        description: "test",
        type: "polling",
        polling: { intervalMinutes: 5, fetch: async () => ({ events: [] }) },
      },
    ],
    actions: [],
  });
});

afterAll(async () => {
  await cleanup();
});

describe("cross-tenant sweeps as NOBYPASSRLS app_user (#1078)", () => {
  it("the sweep pool really is app_user, and a context-free query sees no rows (the original bug)", async () => {
    const role = await db.execute(
      sql`SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
    );
    expect(role[0]).toEqual({ u: "app_user", bypass: false });

    // Either zero rows (setting never set) or a uuid cast error (setting reads '') -- never rows.
    const seen = await db
      .execute(sql`SELECT count(*)::int AS n FROM attachments`)
      .catch((err: unknown) => err);
    if (seen instanceof Error) {
      expect(String(seen)).toContain("uuid");
    } else {
      expect((seen as Array<{ n: number }>)[0]?.n).toBe(0);
    }
  });

  it("attachment-cleanup expires and purges rows for both tenants, touching nothing else", async () => {
    await runAttachmentCleanup();

    for (const tenantId of TENANT_IDS) {
      // old-expired purged; the two stale slots flipped to expired; fresh pending untouched.
      const rows = await adminRows(
        `SELECT upload_token_hash AS h, status FROM attachments WHERE tenant_id = '${tenantId}' ORDER BY upload_token_hash`,
      );
      const tag = tenantId === TENANT_A ? "a" : "b";
      expect(rows).toEqual([
        { h: `hash-${tag}-fresh`, status: "pending" },
        { h: `hash-${tag}-stale`, status: "expired" },
        { h: `hash-${tag}-stale-uploading`, status: "expired" },
      ]);
    }
  });

  it("file-cleanup purges stale pending and deleted files for both tenants, keeping the rest", async () => {
    await runFileCleanup();

    for (const tenantId of TENANT_IDS) {
      const remaining = await adminRows(
        `SELECT storage_key FROM files WHERE tenant_id = '${tenantId}' ORDER BY storage_key`,
      );
      expect(remaining.map((r) => r["storage_key"])).toEqual([
        `tenants/${tenantId}/files/clean.txt`,
        `tenants/${tenantId}/files/fresh-pending.txt`,
      ]);
    }
  });

  it("connector-poll-scheduler schedules each tenant's installation under its own tenant id", async () => {
    mockQueueAdd.mockClear();
    await reconcile();

    const scheduled = mockQueueAdd.mock.calls
      .map((c) => c[1] as { tenantId: string; connectorId: string })
      .filter((p) => TENANT_IDS.includes(p.tenantId))
      .sort((x, y) => x.tenantId.localeCompare(y.tenantId));
    expect(scheduled).toEqual([
      { tenantId: TENANT_A, connectorId: CONNECTOR_DEF_ID },
      { tenantId: TENANT_B, connectorId: CONNECTOR_DEF_ID },
    ]);
  });
});
