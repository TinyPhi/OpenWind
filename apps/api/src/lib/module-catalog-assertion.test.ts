import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/db", () => ({ db: {}, modules: { id: "id" } }));

import {
  assertModuleCatalog,
  ModuleCatalogEmptyError,
  MODULE_CATALOG_EMPTY_MESSAGE,
} from "./module-catalog-assertion.js";

function reader(rows: unknown[]): Parameters<typeof assertModuleCatalog>[0] {
  return {
    select: () => ({ from: () => ({ limit: () => Promise.resolve(rows) }) }),
  };
}

describe("assertModuleCatalog", () => {
  it("resolves when the catalog has rows", async () => {
    await expect(
      assertModuleCatalog(reader([{ id: "x" }])),
    ).resolves.toBeUndefined();
  });

  it("throws ModuleCatalogEmptyError on an empty catalog", async () => {
    await expect(assertModuleCatalog(reader([]))).rejects.toBeInstanceOf(
      ModuleCatalogEmptyError,
    );
  });

  it("names the remedy: migrate step as migration_user and docs/local-setup.md", () => {
    expect(MODULE_CATALOG_EMPTY_MESSAGE).toContain("migration_user");
    expect(MODULE_CATALOG_EMPTY_MESSAGE).toContain("pnpm db:migrate");
    expect(MODULE_CATALOG_EMPTY_MESSAGE).toContain("bootstrap");
    expect(MODULE_CATALOG_EMPTY_MESSAGE).toContain("docs/local-setup.md");
  });

  it("propagates a read failure instead of treating it as a catalog", async () => {
    const failing: Parameters<typeof assertModuleCatalog>[0] = {
      select: () => ({
        from: () => ({ limit: () => Promise.reject(new Error("db down")) }),
      }),
    };
    await expect(assertModuleCatalog(failing)).rejects.toThrow("db down");
  });
});
