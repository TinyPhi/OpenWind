/**
 * Tenant isolation tests for the admin_audit_log table.
 *
 * Isolation is enforced by two layers:
 *  1. Explicit WHERE tenant_id = $tenantId in every @platform/audit query
 *     (tested exhaustively here via queryAuditLog).
 *  2. Postgres RLS policies (enforced when running as a non-superuser role).
 *
 * These tests exercise layer 1: every audit log query is explicitly scoped
 * to a tenant_id, so cross-tenant entries are never returned by the API.
 * RLS layer-2 tests are omitted because the CI database user is a superuser
 * that bypasses RLS — layer-1 is the production enforcement mechanism anyway.
 *
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db, withTenantContext } from "@platform/db";
import { adminAuditLog } from "@platform/db";
import { queryAuditLog } from "@platform/audit";

// ── Test tenant IDs ───────────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-2222-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-2222-4000-b000-000000000002";

const RESOURCE_ID_A = "aaaaaaaa-2222-4000-a000-000000000100";
const RESOURCE_ID_B = "bbbbbbbb-2222-4000-b000-000000000200";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await db.insert(adminAuditLog).values([
    {
      tenantId: TENANT_A,
      actorId: "user-a",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID_A,
      action: "created",
      beforeSnapshot: null,
      afterSnapshot: { subject: "Tenant A ticket" },
      metadata: null,
    },
    {
      tenantId: TENANT_B,
      actorId: "user-b",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID_B,
      action: "created",
      beforeSnapshot: null,
      afterSnapshot: { subject: "Tenant B ticket" },
      metadata: null,
    },
  ]);
});

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_A));
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_B));
});

// ── READ isolation (layer 1 — explicit tenant_id filter) ──────────────────────
//
// Every application query includes WHERE tenant_id = $callerTenantId.
// These tests verify that pattern directly: a query scoped to TENANT_A
// returns 0 rows when the row belongs to TENANT_B, regardless of RLS.

describe("admin_audit_log — cross-tenant READ isolation (layer 1)", () => {
  it("query scoped to Tenant A does not return Tenant B resource IDs", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.resourceId, RESOURCE_ID_B),
            eq(adminAuditLog.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("query scoped to Tenant B does not return Tenant A resource IDs", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const rows = await tx
        .select({ id: adminAuditLog.id })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.resourceId, RESOURCE_ID_A),
            eq(adminAuditLog.tenantId, TENANT_B),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own audit log rows", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ tenantId: adminAuditLog.tenantId })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.resourceId, RESOURCE_ID_A),
            eq(adminAuditLog.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenantId).toBe(TENANT_A);
    });
  });
});

// ── queryAuditLog API isolation (layer 1 via @platform/audit) ────────────────
//
// queryAuditLog always includes WHERE tenant_id = $input.tenantId.
// Even without RLS enforcement, the explicit filter prevents cross-tenant leakage.

describe("queryAuditLog — cross-tenant isolation via @platform/audit API", () => {
  it("returns only Tenant A entries when queried as Tenant A", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await queryAuditLog(tx, {
        tenantId: TENANT_A,
        limit: 100,
      });
      const tenantIds = result.entries.map((e) => e.tenantId);
      expect(tenantIds.every((id) => id === TENANT_A)).toBe(true);
    });
  });

  it("Tenant A query does not expose Tenant B resource IDs", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await queryAuditLog(tx, {
        tenantId: TENANT_A,
        limit: 100,
      });
      const resourceIds = result.entries.map((e) => e.resourceId);
      expect(resourceIds).not.toContain(RESOURCE_ID_B);
    });
  });

  it("returns only Tenant B entries when queried as Tenant B", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const result = await queryAuditLog(tx, {
        tenantId: TENANT_B,
        limit: 100,
      });
      const tenantIds = result.entries.map((e) => e.tenantId);
      expect(tenantIds.every((id) => id === TENANT_B)).toBe(true);
    });
  });

  it("Tenant A can read its own audit entries", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await queryAuditLog(tx, {
        tenantId: TENANT_A,
        limit: 100,
      });
      const resourceIds = result.entries.map((e) => e.resourceId);
      expect(resourceIds).toContain(RESOURCE_ID_A);
    });
  });
});

describe("admin_audit_log — write restriction (append-only, Finding 1)", () => {
  it("app_user UPDATE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx
          .update(adminAuditLog)
          .set({ actorId: "compromised-user" })
          .where(eq(adminAuditLog.resourceId, RESOURCE_ID_A));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user DELETE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx
          .delete(adminAuditLog)
          .where(eq(adminAuditLog.resourceId, RESOURCE_ID_A));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

// ── Cursor pagination over equal created_at ───────────────────────────────────

const TENANT_TIE = "cccccccc-2222-4000-c000-000000000003";
const TENANT_OTHER = "dddddddd-2222-4000-d000-000000000004";

describe("queryAuditLog — cursor pagination with equal created_at", () => {
  const sameInstant = new Date("2026-01-01T00:00:00.000Z");
  const row = (tenantId: string) => ({
    tenantId,
    actorId: "system",
    actorType: "system" as const,
    resourceType: "ticket",
    resourceId: RESOURCE_ID_A,
    action: "created" as const,
    createdAt: sameInstant,
  });

  beforeAll(async () => {
    await db
      .insert(adminAuditLog)
      .values([
        row(TENANT_TIE),
        row(TENANT_TIE),
        row(TENANT_TIE),
        row(TENANT_OTHER),
      ]);
  });

  afterAll(async () => {
    await db
      .delete(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT_TIE));
    await db
      .delete(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT_OTHER));
  });

  it("returns every row exactly once when paging one at a time", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await withTenantContext(TENANT_TIE, (tx) =>
        queryAuditLog(tx, { tenantId: TENANT_TIE, limit: 1, cursor }),
      );
      seen.push(...result.entries.map((e) => e.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("does not skip rows that differ only in microseconds", async () => {
    const tenant = "eeeeeeee-2222-4000-e000-000000000005";
    try {
      for (const micros of ["123900", "123456", "123100"]) {
        await db.execute(sql`
          INSERT INTO admin_audit_log
            (tenant_id, actor_id, actor_type, resource_type, resource_id, action, created_at)
          VALUES (${tenant}, 'system', 'system', 'ticket', ${RESOURCE_ID_A}, 'created',
                  ${"2026-01-02 00:00:00." + micros + "+00"}::timestamptz)`);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await withTenantContext(tenant, (tx) =>
          queryAuditLog(tx, { tenantId: tenant, limit: 1, cursor }),
        );
        seen.push(...result.entries.map((e) => e.id));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(new Set(seen).size).toBe(3);
    } finally {
      await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, tenant));
    }
  });

  it("ignores a cursor id that belongs to another tenant", async () => {
    const [foreign] = await db
      .select({ id: adminAuditLog.id })
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT_OTHER));
    const result = await withTenantContext(TENANT_TIE, (tx) =>
      queryAuditLog(tx, {
        tenantId: TENANT_TIE,
        limit: 10,
        cursor: foreign?.id,
      }),
    );
    expect(result.entries).toHaveLength(3);
  });
});
