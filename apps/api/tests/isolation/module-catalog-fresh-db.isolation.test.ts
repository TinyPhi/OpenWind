/**
 * ADR-005 Amendment 1 / issue #1079: the module catalog on a FRESH database, seen the way
 * production sees it.
 *
 * Every other suite connects as a superuser (CI migrates as `platform`), so a grant gap on
 * `modules` is invisible to it: that is how 0061 broke seeding without a single red test.
 * This suite closes that blind spot. It migrates a throwaway database as the real
 * `migration_user` (through the actual run-migrations entry point, which syncs the catalog),
 * then connects as a real `app_user` login, not SET LOCAL ROLE from a superuser.
 *
 * Opt-in: set CATALOG_TEST_ADMIN_URL to a superuser URL of a cluster that already has the
 * app_user and migration_user roles (docker/postgres/init/001_setup.sql), e.g.
 *   postgresql://platform:<pw>@localhost:5432/postgres
 * The suite creates (never drops) the database `platform_test_m1079` and is re-runnable.
 * Role passwords default to the dev values in 001_setup.sql; override with
 * CATALOG_TEST_APP_PASSWORD / CATALOG_TEST_MIGRATION_PASSWORD. Without the env var it skips.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import postgres from "postgres";
import { MODULE_CATALOG } from "@platform/db";
import type {
  assertModuleCatalog,
  ModuleCatalogEmptyError,
} from "../../src/lib/module-catalog-assertion.js";
import type { ModuleService } from "../../src/services/module-service.js";

const ADMIN_URL = process.env["CATALOG_TEST_ADMIN_URL"];
const DB_NAME = "platform_test_m1079";
const APP_PW =
  process.env["CATALOG_TEST_APP_PASSWORD"] ?? "app_user_dev_password";
const MIG_PW =
  process.env["CATALOG_TEST_MIGRATION_PASSWORD"] ??
  "migration_user_dev_password";
const TENANT_ID = "00000000-0000-0000-0000-000000001079";
const EXPECTED_SLUGS = MODULE_CATALOG.map((m) => m.slug).sort();
const CORE_SLUGS = MODULE_CATALOG.filter((m) => m.category === "core")
  .map((m) => m.slug)
  .sort();

function urlFor(user: string, password: string, dbName: string): string {
  const u = new URL(ADMIN_URL as string);
  u.username = user;
  u.password = password;
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function deniedWith42501(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: "42501" });
}

describe.skipIf(!ADMIN_URL)(
  "module catalog on a fresh database (real migration_user then real app_user)",
  () => {
    let admin: postgres.Sql;
    let app: postgres.Sql;
    const appUrl = (): string => urlFor("app_user", APP_PW, DB_NAME);
    const migUrl = (): string => urlFor("migration_user", MIG_PW, DB_NAME);

    function runMigrations(): string {
      // run-migrations logs to stderr, so capture both streams.
      const r = spawnSync("pnpm", ["exec", "tsx", "src/run-migrations.ts"], {
        cwd: join(__dirname, "../../../../packages/db"),
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: migUrl(),
          NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 240_000,
      });
      const output = `${r.stdout}\n${r.stderr}`;
      if (r.status !== 0) {
        throw new Error(`run-migrations exited ${r.status}:\n${output}`);
      }
      return output;
    }

    beforeAll(async () => {
      const maintenance = postgres(
        urlFor(
          new URL(ADMIN_URL as string).username,
          decodeURIComponent(new URL(ADMIN_URL as string).password),
          "postgres",
        ),
        { max: 1 },
      );
      try {
        const existing = await maintenance`
          SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`;
        if (existing.length === 0) {
          await maintenance.unsafe(`CREATE DATABASE ${DB_NAME}`);
        }
        await maintenance.unsafe(
          `GRANT CONNECT ON DATABASE ${DB_NAME} TO app_user;
           GRANT CONNECT, CREATE ON DATABASE ${DB_NAME} TO migration_user;
           GRANT CONNECT ON DATABASE ${DB_NAME} TO analytics_user;`,
        );
      } finally {
        await maintenance.end();
      }

      // Mirror docker/postgres/init/001_setup.sql's per-database part, as the superuser.
      admin = postgres(
        urlFor(
          new URL(ADMIN_URL as string).username,
          decodeURIComponent(new URL(ADMIN_URL as string).password),
          DB_NAME,
        ),
        { max: 2 },
      );
      await admin.unsafe(`
        CREATE EXTENSION IF NOT EXISTS "pgcrypto";
        CREATE EXTENSION IF NOT EXISTS "pg_trgm";
        CREATE EXTENSION IF NOT EXISTS "btree_gin";
        ALTER SCHEMA public OWNER TO migration_user;
        GRANT USAGE ON SCHEMA public TO app_user;
        GRANT USAGE ON SCHEMA public TO analytics_user;
        ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
        ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
          GRANT USAGE, SELECT ON SEQUENCES TO app_user;
      `);

      // The real entry point: migrations + catalog sync, as migration_user.
      const out = runMigrations();
      expect(out).toContain("Module catalog synced");

      app = postgres(appUrl(), { max: 2, prepare: false });
    }, 300_000);

    afterAll(async () => {
      await app?.end();
      await admin?.end();
    });

    it("run-migrations leaves exactly the catalog's slugs in modules", async () => {
      const rows = await app<
        { slug: string }[]
      >`SELECT slug FROM modules ORDER BY slug`;
      expect(rows.map((r) => r.slug)).toEqual(EXPECTED_SLUGS);
    });

    it("is idempotent: running it again changes no row count", async () => {
      const out = runMigrations();
      expect(out).toContain("Module catalog synced");
      const [{ n }] = await app<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM modules`;
      expect(n).toBe(EXPECTED_SLUGS.length);
    }, 300_000);

    it("app_user cannot INSERT, DELETE, or UPDATE catalog columns", async () => {
      await deniedWith42501(
        app`INSERT INTO modules (slug, name, version) VALUES ('rogue', 'Rogue', '1.0.0')`,
      );
      await deniedWith42501(app`DELETE FROM modules WHERE slug = 'helpdesk'`);
      await deniedWith42501(
        app`UPDATE modules SET category = 'core' WHERE slug = 'tender'`,
      );
      await deniedWith42501(
        app`UPDATE modules SET name = 'Hijacked' WHERE slug = 'helpdesk'`,
      );
      await deniedWith42501(
        app`UPDATE modules SET min_plan = 'free' WHERE slug = 'helpdesk'`,
      );
      const [tender] = await admin<{ category: string }[]>`
        SELECT category FROM modules WHERE slug = 'tender'`;
      expect(tender?.category).toBe("optional");
    });

    it("app_user can toggle is_visible (column-scoped grant), and a re-sync preserves it", async () => {
      try {
        await app`UPDATE modules SET is_visible = false, updated_at = now() WHERE slug = 'tender'`;
        runMigrations();
        const [row] = await app<{ is_visible: boolean }[]>`
          SELECT is_visible FROM modules WHERE slug = 'tender'`;
        expect(row?.is_visible).toBe(false);
      } finally {
        await app`UPDATE modules SET is_visible = true WHERE slug = 'tender'`;
      }
    }, 300_000);

    it("a re-sync refreshes category and version that drifted in the table", async () => {
      await admin`UPDATE modules SET category = 'core', version = '9.9.9' WHERE slug = 'tender'`;
      runMigrations();
      const [row] = await app<{ category: string; version: string }[]>`
        SELECT category, version FROM modules WHERE slug = 'tender'`;
      expect(row).toEqual({ category: "optional", version: "0.0.1" });
    }, 300_000);

    describe("through the API's own code, connected as the real app_user", () => {
      type ApiModules = {
        ModuleService: typeof ModuleService;
        assertModuleCatalog: typeof assertModuleCatalog;
        ModuleCatalogEmptyError: typeof ModuleCatalogEmptyError;
      };
      let api: ApiModules;
      const savedEnv: Record<string, string | undefined> = {};

      beforeAll(async () => {
        for (const k of ["DATABASE_URL"]) savedEnv[k] = process.env[k];
        process.env["DATABASE_URL"] = appUrl();
        vi.resetModules();
        const svc = await import("../../src/services/module-service.js");
        const asrt = await import("../../src/lib/module-catalog-assertion.js");
        api = {
          ModuleService: svc.ModuleService,
          assertModuleCatalog: asrt.assertModuleCatalog,
          ModuleCatalogEmptyError: asrt.ModuleCatalogEmptyError,
        };
        await admin`
          INSERT INTO tenants (id, name, slug, plan, status, config)
          VALUES (${TENANT_ID}, 'Catalog Fresh DB Tenant', 'catalog-fresh-db-1079', 'standard', 'active', '{}'::jsonb)
          ON CONFLICT (id) DO NOTHING`;
      });

      afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        vi.resetModules();
      });

      it("installCoreModules installs every core module", async () => {
        const result = await api.ModuleService.installCoreModules(TENANT_ID);
        expect(result.failed).toEqual([]);
        expect([...result.succeeded].sort()).toEqual(CORE_SLUGS);
      }, 120_000);

      it("setVisibility works as app_user", async () => {
        try {
          await api.ModuleService.setVisibility("vendor-approval", false);
          const [row] = await admin<{ is_visible: boolean }[]>`
            SELECT is_visible FROM modules WHERE slug = 'vendor-approval'`;
          expect(row?.is_visible).toBe(false);
        } finally {
          await admin`UPDATE modules SET is_visible = true WHERE slug = 'vendor-approval'`;
        }
      });

      it("the startup assertion passes on a synced catalog", async () => {
        await expect(api.assertModuleCatalog()).resolves.toBeUndefined();
      });

      it("the startup assertion fails with a remediation message on an empty catalog", async () => {
        const rows = await admin`SELECT * FROM modules`;
        expect(rows.length).toBe(EXPECTED_SLUGS.length);
        try {
          await admin`DELETE FROM modules`;
          const err = await api.assertModuleCatalog().then(
            () => null,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(api.ModuleCatalogEmptyError);
          const message = (err as Error).message;
          expect(message).toContain("empty");
          expect(message).toContain("migration_user");
          expect(message).toContain("pnpm db:migrate");
          expect(message).toContain("docs/local-setup.md");
        } finally {
          runMigrations();
        }
        const [{ n }] = await admin<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM modules`;
        expect(n).toBe(EXPECTED_SLUGS.length);
      }, 300_000);
    });
  },
);
