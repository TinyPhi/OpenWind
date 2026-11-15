/**
 * ADR-019 Stage 2 criterion 14 (#1139) -- reporting-audit-retention.ts's real
 * delete SQL and the narrow reporting_audit_retention_role (migration 0164),
 * exercised against a real Postgres database.
 *
 * Verifies:
 * - app_user cannot DELETE reporting rows directly (append-only audit log).
 * - reporting_audit_retention_role can delete reporting.* rows older than cap.
 * - reporting_audit_retention_role cannot see or delete non-reporting rows.
 * - reporting_audit_retention_role cannot INSERT, UPDATE, or touch other tables.
 * - reporting_audit_retention_role is NOLOGIN, NOT BYPASSRLS, and app_user
 *   holds it with INHERIT FALSE.
 * - Migration 0164 attribute guard works for a non-superuser migration runner.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  setReportingAuditRetentionRole,
} from "@platform/db";
import { runReportingAuditRetentionSweep } from "../../src/reporting-audit-retention.js";

const TENANT_ID = "ffffffff-c000-4000-a000-00000000004a";
const RESOURCE_ID = "ffffffff-c000-4000-a000-00000000004b";
const OLD_DATE = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000);
const RECENT_DATE = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "Reporting audit retention isolation tenant",
      slug: `reporting-audit-retention-${Date.now()}`,
    })
    .onConflictDoNothing();

  await db.insert(adminAuditLog).values([
    // Old reporting row -- should be deleted by sweep
    {
      tenantId: TENANT_ID,
      actorId: "rep-user-old",
      actorType: "user",
      resourceType: "dataset",
      resourceId: RESOURCE_ID,
      action: "reporting.query_executed",
      metadata: { sql: "SELECT 1" },
      createdAt: OLD_DATE,
    },
    // Recent reporting row -- must survive
    {
      tenantId: TENANT_ID,
      actorId: "rep-user-recent",
      actorType: "user",
      resourceType: "dataset",
      resourceId: RESOURCE_ID,
      action: "reporting.query_executed",
      metadata: { sql: "SELECT 2" },
      createdAt: RECENT_DATE,
    },
    // Old non-reporting row -- must survive reporting sweep untouched!
    {
      tenantId: TENANT_ID,
      actorId: "core-user-old",
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
      createdAt: OLD_DATE,
    },
  ]);
});

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("reporting-audit-retention: real sweep against Postgres (ADR-019 Stage 2, #1139)", () => {
  it("deletes reporting rows older than cap, leaving recent reporting rows and non-reporting rows untouched", async () => {
    const deleted = await runReportingAuditRetentionSweep(90);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT_ID));

    const actions = remaining.map((r) => r.action);
    expect(actions).toContain("reporting.query_executed");
    expect(actions).toContain("created");

    const reportingRows = remaining.filter(
      (r) => r.action === "reporting.query_executed",
    );
    expect(reportingRows).toHaveLength(1);
    expect(reportingRows[0]?.actorId).toBe("rep-user-recent");

    const ticketRows = remaining.filter((r) => r.action === "created");
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0]?.actorId).toBe("core-user-old");
  });
});

const AS_APP_USER = sql`SET LOCAL ROLE app_user`;
const asReportingRetention = sql`SET LOCAL ROLE reporting_audit_retention_role`;

describe("reporting_audit_retention_role (migration 0164, #1139)", () => {
  async function expectDenied(
    setup: ReturnType<typeof sql>,
    statement: ReturnType<typeof sql>,
  ): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(setup);
        await tx.execute(statement);
      }),
    ).rejects.toThrow();
  }

  const DELETE_AUDIT = sql`DELETE FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}`;

  it("app_user cannot DELETE a reporting row directly", async () => {
    await expectDenied(AS_APP_USER, DELETE_AUDIT);
  });

  it("reporting_audit_retention_role can delete reporting rows", async () => {
    const marker = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await db.insert(adminAuditLog).values({
      tenantId: TENANT_ID,
      actorId: "rep-user-to-del",
      actorType: "user",
      resourceType: "dashboard",
      resourceId: RESOURCE_ID,
      action: "reporting.exported",
      createdAt: marker,
    });

    const deleted = await db.transaction(async (tx) => {
      await setReportingAuditRetentionRole(tx);
      return tx.execute<{ n: number }>(
        sql`WITH d AS (DELETE FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}
            AND action = 'reporting.exported' RETURNING 1) SELECT count(*)::int AS n FROM d`,
      );
    });
    expect(deleted[0]?.n).toBe(1);
  });

  it("reporting_audit_retention_role cannot see or delete non-reporting rows", async () => {
    const counts = await db.transaction(async (tx) => {
      await setReportingAuditRetentionRole(tx);
      const seen = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM admin_audit_log
            WHERE tenant_id = ${TENANT_ID} AND action NOT LIKE 'reporting.%'`,
      );
      const del = await tx.execute<{ n: number }>(
        sql`WITH d AS (DELETE FROM admin_audit_log WHERE tenant_id = ${TENANT_ID}
            AND action NOT LIKE 'reporting.%' RETURNING 1)
            SELECT count(*)::int AS n FROM d`,
      );
      return { seen: seen[0]?.n, deleted: del[0]?.n };
    });
    expect(counts).toEqual({ seen: 0, deleted: 0 });
  });

  it("reporting_audit_retention_role cannot UPDATE or INSERT admin_audit_log", async () => {
    await expectDenied(
      asReportingRetention,
      sql`UPDATE admin_audit_log SET action = 'reporting.tampered' WHERE tenant_id = ${TENANT_ID}`,
    );
    await expectDenied(
      asReportingRetention,
      sql`INSERT INTO admin_audit_log (tenant_id, actor_id, actor_type, resource_type, resource_id, action)
          VALUES (${TENANT_ID}, 'x', 'user', 'dataset', ${RESOURCE_ID}, 'reporting.query_executed')`,
    );
  });

  it("reporting_audit_retention_role cannot touch other tables", async () => {
    await expectDenied(
      asReportingRetention,
      sql`SELECT 1 FROM tenants LIMIT 1`,
    );
    await expectDenied(
      asReportingRetention,
      sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`,
    );
  });

  it("is NOLOGIN and NOT BYPASSRLS, and app_user holds it without inheriting", async () => {
    const [role] = await db.execute<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      sql`SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'reporting_audit_retention_role'`,
    );
    expect(role).toEqual({
      rolcanlogin: false,
      rolbypassrls: false,
      rolsuper: false,
    });
    const [m] = await db.execute<{ inherit_option: boolean }>(
      sql`SELECT inherit_option FROM pg_auth_members
          WHERE roleid = 'reporting_audit_retention_role'::regrole
            AND member = 'app_user'::regrole`,
    );
    expect(m?.inherit_option).toBe(false);
  });
});

describe("0164 attribute guard works for a non-superuser migration runner (#1153)", () => {
  const migrationSql = readFileSync(
    fileURLToPath(
      new URL(
        "../../../../packages/db/migrations/0164_reporting_audit_retention_role.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const guardBlock = /^DO \$\$[\s\S]*?^\$\$;/m.exec(migrationSql)?.[0];
  const ROLLBACK = new Error("rollback");

  async function inRolledBackTx(
    fn: (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => Promise<void>,
  ): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        await fn(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  }

  async function connectionIsSuperuser(): Promise<boolean> {
    const [r] = await db.execute<{ rolsuper: boolean }>(
      sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    return r?.rolsuper === true;
  }

  const asNonSuperuser = async (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ): Promise<void> => {
    await tx.execute(
      sql`CREATE ROLE m1164_runner NOLOGIN CREATEROLE NOSUPERUSER`,
    );
    await tx.execute(sql`SET LOCAL ROLE m1164_runner`);
  };

  it("finds the guard block in the migration file", () => {
    expect(guardBlock).toBeDefined();
    expect(guardBlock).not.toMatch(/^ALTER ROLE/m);
  });

  it("is a no-op for a non-superuser when the existing role has the expected attributes", async ({
    skip,
  }) => {
    if (!guardBlock || !(await connectionIsSuperuser())) skip();
    await inRolledBackTx(async (tx) => {
      await asNonSuperuser(tx);
      await tx.execute(sql.raw(guardBlock));
    });
  });

  it("raises loudly for a non-superuser when the existing role has BYPASSRLS", async ({
    skip,
  }) => {
    if (!guardBlock || !(await connectionIsSuperuser())) skip();
    let raised: unknown;
    await inRolledBackTx(async (tx) => {
      await tx.execute(
        sql`ALTER ROLE reporting_audit_retention_role BYPASSRLS`,
      );
      await asNonSuperuser(tx);
      await tx.execute(sql`SAVEPOINT guard`);
      try {
        await tx.execute(sql.raw(guardBlock));
      } catch (err) {
        raised = err;
      }
    });
    expect(String(raised)).toMatch(/unsafe attributes|Failed query/);
    expect(
      JSON.stringify(raised, Object.getOwnPropertyNames(raised ?? {})),
    ).toMatch(/unsafe attributes/);
  });

  it("repairs the role when the caller is a superuser", async ({ skip }) => {
    if (!guardBlock || !(await connectionIsSuperuser())) skip();
    await inRolledBackTx(async (tx) => {
      await tx.execute(
        sql`ALTER ROLE reporting_audit_retention_role BYPASSRLS LOGIN`,
      );
      await tx.execute(sql.raw(guardBlock));
      const [r] = await tx.execute<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }>(
        sql`SELECT rolbypassrls, rolcanlogin FROM pg_roles
            WHERE rolname = 'reporting_audit_retention_role'`,
      );
      expect(r).toEqual({ rolbypassrls: false, rolcanlogin: false });
    });
  });
});
