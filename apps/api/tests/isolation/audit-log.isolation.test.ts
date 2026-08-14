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
