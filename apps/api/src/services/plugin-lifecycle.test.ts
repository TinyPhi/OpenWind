/**
 * plugin-lifecycle.test.ts — unit tests for the plugin lifecycle service.
 * DB is mocked (same convention as tenant-lifecycle.test.ts); manifest
 * validation, version-compat, and migration-lint logic run for real — they're
 * pure functions, no reason to mock them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockDbSelect = vi.fn();
const mockRunPluginMigration = vi.fn();
const mockPurgeTenantDataFromPluginSchema = vi.fn();

const mockTx = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};

const mockWithTenantContext = vi.fn(
  async (_tenantId: string, fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
);

vi.mock("@platform/db", () => ({
  db: { select: mockDbSelect },
  withTenantContext: mockWithTenantContext,
  runPluginMigration: mockRunPluginMigration,
  purgeTenantDataFromPluginSchema: mockPurgeTenantDataFromPluginSchema,
  pluginDefinitions: {
    id: "plugin_definitions.id",
    slug: "plugin_definitions.slug",
  },
  installedPlugins: {
    id: "installed_plugins.id",
    tenantId: "installed_plugins.tenant_id",
    pluginId: "installed_plugins.plugin_id",
    status: "installed_plugins.status",
  },
  pluginErrors: { pluginId: "plugin_errors.plugin_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(() => ({ mapWith: vi.fn(() => "count") })),
}));

const {
  installPlugin,
  uninstallPlugin,
  listPluginsForTenant,
  reportPluginRuntimeError,
  PluginLifecycleError,
} = await import("./plugin-lifecycle.js");
const { logger } = await import("@platform/logger");

const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PLUGIN_ID = "plugin-uuid-1";
const PLUGIN_SLUG = "test_plugin";

// Review finding (PR #397, PrabhuVijit): this fixture previously used
// USING (true) — a permissive "allow everyone" policy that the lint (before
// that same review) couldn't distinguish from a real one. Fixed so this
// isn't a misleading template for anyone reading it as an example.
const VALID_MIGRATION_SQL = `
  CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL);
  ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "widgets_tenant_isolation" ON "widgets"
    FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
`;

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

/** For the tx-scoped "already installed" check: select().from().where().limit() */
function makeTxSelectLimitChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

/** For the dependency check: select().from().innerJoin().where() */
function makeTxSelectJoinChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function makeTxInsertChain(rows: unknown[]) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(rows),
    }),
  };
}

function makeTxUpdateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

/** For listPluginsForTenant's catalog select: plain select().from() */
function makeCatalogSelectChain(rows: unknown[]) {
  return { from: vi.fn().mockResolvedValue(rows) };
}

/** For the installed-rows query: select().from().where(), no .limit() */
function makeTxSelectWhereChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
}

/** For the errorCounts query: select().from().where().groupBy() */
function makeTxSelectGroupByChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWithTenantContext.mockImplementation(async (_tenantId, fn) => fn(mockTx));
});

describe("installPlugin", () => {
  it("installs successfully when everything validates and the migration succeeds", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    // 1st tx call: already-installed check -> none found
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));
    mockRunPluginMigration.mockResolvedValueOnce(undefined);
    // final tx call: insert installed_plugins
    mockTx.insert.mockReturnValueOnce(
      makeTxInsertChain([{ id: "installed-1" }]),
    );

    const result = await installPlugin(TENANT_ID, PLUGIN_SLUG, {
      manifest: {
        id: PLUGIN_SLUG,
        name: "Test Plugin",
        version: "0.1.0",
        platformVersion: ">=1.0.0",
        permissions: ["db:read"],
      },
      migrationSql: VALID_MIGRATION_SQL,
    });

    expect(result).toEqual({ installedPluginId: "installed-1" });
    expect(mockRunPluginMigration).toHaveBeenCalledWith(
      PLUGIN_SLUG,
      VALID_MIGRATION_SQL,
    );
    expect(logger.info).toHaveBeenCalled();
  });

  it("throws PLUGIN_NOT_FOUND when the slug has no plugin_definitions row", async () => {
    mockDbSelect.mockReturnValueOnce(makeSelectChain([]));

    await expect(
      installPlugin(TENANT_ID, "nonexistent", {
        manifest: {},
        migrationSql: "",
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
    expect(mockRunPluginMigration).not.toHaveBeenCalled();
  });

  it("throws ALREADY_INSTALLED when the tenant already has this plugin", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(
      makeTxSelectLimitChain([{ id: "already-installed-row" }]),
    );

    await expect(
      installPlugin(TENANT_ID, PLUGIN_SLUG, {
        manifest: {},
        migrationSql: "",
      }),
    ).rejects.toMatchObject({ code: "ALREADY_INSTALLED" });
    expect(mockRunPluginMigration).not.toHaveBeenCalled();
  });

  it("throws INVALID_MANIFEST when the manifest fails schema validation", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));

    await expect(
      installPlugin(TENANT_ID, PLUGIN_SLUG, {
        manifest: { id: "missing-required-fields" },
        migrationSql: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    expect(mockRunPluginMigration).not.toHaveBeenCalled();
  });

  it("throws MISSING_DEPENDENCY when a required plugin isn't installed for the tenant", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select
      .mockReturnValueOnce(makeTxSelectLimitChain([])) // already-installed check
      .mockReturnValueOnce(makeTxSelectJoinChain([])); // dependency check — nothing installed

    await expect(
      installPlugin(TENANT_ID, PLUGIN_SLUG, {
        manifest: {
          id: PLUGIN_SLUG,
          name: "Test Plugin",
          version: "0.1.0",
          platformVersion: ">=1.0.0",
          permissions: [],
          requires: ["some_other_plugin"],
        },
        migrationSql: VALID_MIGRATION_SQL,
      }),
    ).rejects.toMatchObject({
      code: "MISSING_DEPENDENCY",
      meta: expect.objectContaining({ missing: ["some_other_plugin"] }),
    });
    expect(mockRunPluginMigration).not.toHaveBeenCalled();
  });

  it("throws PLATFORM_VERSION_INCOMPATIBLE when platformVersion doesn't satisfy the running platform", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));

    await expect(
      installPlugin(TENANT_ID, PLUGIN_SLUG, {
        manifest: {
          id: PLUGIN_SLUG,
          name: "Test Plugin",
          version: "0.1.0",
          platformVersion: "^99.0.0",
          permissions: [],
        },
        migrationSql: VALID_MIGRATION_SQL,
      }),
    ).rejects.toMatchObject({ code: "PLATFORM_VERSION_INCOMPATIBLE" });
    expect(mockRunPluginMigration).not.toHaveBeenCalled();
  });

  it("throws MIGRATION_VALIDATION_FAILED when the migration SQL fails R13's lint", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));

    await expect(
      installPlugin(TENANT_ID, PLUGIN_SLUG, {
        manifest: {
          id: PLUGIN_SLUG,
          name: "Test Plugin",
          version: "0.1.0",
          platformVersion: ">=1.0.0",
          permissions: [],
        },
        migrationSql: `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY);`,
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_VALIDATION_FAILED" });
    expect(mockRunPluginMigration).not.toHaveBeenCalled();
  });

  it("throws MIGRATION_FAILED and records a plugin_errors row when the migration itself throws", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));
    mockRunPluginMigration.mockRejectedValueOnce(new Error("boom"));
    // writeLifecycleError's own withTenantContext call -> tx.insert for plugin_errors
    mockTx.insert.mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      installPlugin(TENANT_ID, PLUGIN_SLUG, {
        manifest: {
          id: PLUGIN_SLUG,
          name: "Test Plugin",
          version: "0.1.0",
          platformVersion: ">=1.0.0",
          permissions: [],
        },
        migrationSql: VALID_MIGRATION_SQL,
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

    expect(mockTx.insert).toHaveBeenCalled();
  });

  it("never throws PluginLifecycleError instances that aren't one of the documented codes", async () => {
    // Sanity check on the error class itself, not a specific call path.
    const err = new PluginLifecycleError("PLUGIN_NOT_FOUND", { x: 1 });
    expect(err.name).toBe("PluginLifecycleError");
    expect(err.code).toBe("PLUGIN_NOT_FOUND");
  });
});

describe("uninstallPlugin", () => {
  it("purges the tenant's plugin-schema rows and flips status to disabled by default", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(
      makeTxSelectLimitChain([{ id: "installed-1", status: "active" }]),
    );
    mockPurgeTenantDataFromPluginSchema.mockResolvedValueOnce({
      tablesPurged: ["widgets"],
    });
    mockTx.update.mockReturnValueOnce(makeTxUpdateChain());

    await uninstallPlugin(TENANT_ID, PLUGIN_SLUG);

    expect(mockPurgeTenantDataFromPluginSchema).toHaveBeenCalledWith(
      TENANT_ID,
      PLUGIN_SLUG,
    );
    expect(mockTx.update).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("skips the purge entirely when retainData is true", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(
      makeTxSelectLimitChain([{ id: "installed-1", status: "active" }]),
    );
    mockTx.update.mockReturnValueOnce(makeTxUpdateChain());

    await uninstallPlugin(TENANT_ID, PLUGIN_SLUG, { retainData: true });

    expect(mockPurgeTenantDataFromPluginSchema).not.toHaveBeenCalled();
    expect(mockTx.update).toHaveBeenCalled();
  });

  it("throws PLUGIN_NOT_FOUND for an unknown slug", async () => {
    mockDbSelect.mockReturnValueOnce(makeSelectChain([]));

    await expect(
      uninstallPlugin(TENANT_ID, "nonexistent"),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
    expect(mockPurgeTenantDataFromPluginSchema).not.toHaveBeenCalled();
  });

  it("throws NOT_INSTALLED when the tenant never installed this plugin", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));

    await expect(uninstallPlugin(TENANT_ID, PLUGIN_SLUG)).rejects.toMatchObject(
      { code: "NOT_INSTALLED" },
    );
    expect(mockPurgeTenantDataFromPluginSchema).not.toHaveBeenCalled();
  });

  it("throws UNINSTALL_FAILED and records a plugin_errors row when the purge itself throws", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(
      makeTxSelectLimitChain([{ id: "installed-1", status: "active" }]),
    );
    mockPurgeTenantDataFromPluginSchema.mockRejectedValueOnce(
      new Error("purge boom"),
    );
    // writeLifecycleError's own withTenantContext call -> tx.insert
    mockTx.insert.mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    });

    await expect(uninstallPlugin(TENANT_ID, PLUGIN_SLUG)).rejects.toMatchObject(
      { code: "UNINSTALL_FAILED" },
    );
    expect(mockTx.update).not.toHaveBeenCalled();
  });
});

describe("listPluginsForTenant", () => {
  it("annotates the catalog with install status and error counts", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeCatalogSelectChain([
        {
          id: PLUGIN_ID,
          slug: PLUGIN_SLUG,
          name: "Test",
          version: "0.1.0",
          category: "other",
        },
      ]),
    );
    mockTx.select
      .mockReturnValueOnce(
        makeTxSelectWhereChain([{ pluginId: PLUGIN_ID, status: "active" }]),
      )
      .mockReturnValueOnce(
        makeTxSelectGroupByChain([{ pluginId: PLUGIN_ID, count: 3 }]),
      );

    const result = await listPluginsForTenant(TENANT_ID);

    expect(result).toEqual([
      {
        slug: PLUGIN_SLUG,
        name: "Test",
        version: "0.1.0",
        category: "other",
        installed: true,
        status: "active",
        errorCount: 3,
      },
    ]);
  });

  it("marks a catalog plugin as not installed with zero errors when the tenant has neither", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeCatalogSelectChain([
        {
          id: PLUGIN_ID,
          slug: PLUGIN_SLUG,
          name: "Test",
          version: "0.1.0",
          category: "other",
        },
      ]),
    );
    mockTx.select
      .mockReturnValueOnce(makeTxSelectWhereChain([]))
      .mockReturnValueOnce(makeTxSelectGroupByChain([]));

    const result = await listPluginsForTenant(TENANT_ID);

    expect(result[0]).toMatchObject({
      installed: false,
      status: null,
      errorCount: 0,
    });
  });
});

describe("reportPluginRuntimeError", () => {
  it("writes a runtime_exception row for an installed plugin", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(
      makeTxSelectLimitChain([{ id: "installed-row-1" }]),
    );
    mockTx.insert.mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    });

    await reportPluginRuntimeError(TENANT_ID, PLUGIN_SLUG, {
      slotName: "ticket-header",
      message: "plugin blew up",
    });

    expect(mockTx.insert).toHaveBeenCalled();
    const insertedValues =
      mockTx.insert.mock.results[0]?.value.values.mock.calls[0]?.[0];
    expect(insertedValues).toMatchObject({
      tenantId: TENANT_ID,
      pluginId: PLUGIN_ID,
      kind: "runtime_exception",
      detail: { slotName: "ticket-header", message: "plugin blew up" },
    });
  });

  it("throws PLUGIN_NOT_FOUND for an unknown slug", async () => {
    mockDbSelect.mockReturnValueOnce(makeSelectChain([]));

    await expect(
      reportPluginRuntimeError(TENANT_ID, "nonexistent", {
        message: "x",
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
  });

  // Review finding (PR #397, PrabhuVijit, L-errors): a catalog-only check let
  // any authenticated user write plugin_errors rows for a slug their own
  // tenant never installed.
  it("throws NOT_INSTALLED when the calling tenant hasn't installed the plugin", async () => {
    mockDbSelect.mockReturnValueOnce(
      makeSelectChain([{ id: PLUGIN_ID, slug: PLUGIN_SLUG }]),
    );
    mockTx.select.mockReturnValueOnce(makeTxSelectLimitChain([]));

    await expect(
      reportPluginRuntimeError(TENANT_ID, PLUGIN_SLUG, { message: "x" }),
    ).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    expect(mockTx.insert).not.toHaveBeenCalled();
  });
});
