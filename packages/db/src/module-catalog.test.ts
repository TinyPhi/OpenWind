import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  MODULE_CATALOG,
  ModuleCatalogEntrySchema,
  syncModuleCatalog,
  type ModuleCatalogExecutor,
} from "./module-catalog.js";
import { modules } from "./schema/platform.js";

describe("MODULE_CATALOG", () => {
  it("has unique slugs and passes its own schema", () => {
    const slugs = MODULE_CATALOG.map((m) => m.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const entry of MODULE_CATALOG) {
      expect(() => ModuleCatalogEntrySchema.parse(entry)).not.toThrow();
    }
  });

  it("classifies the seven standard modules as core and the rest as optional (ADR-005)", () => {
    const core = MODULE_CATALOG.filter((m) => m.category === "core")
      .map((m) => m.slug)
      .sort();
    expect(core).toEqual([
      "crm",
      "helpdesk",
      "hrms",
      "invoicing",
      "procurement",
      "projects",
      "reimbursements",
    ]);
    const optional = MODULE_CATALOG.filter((m) => m.category === "optional")
      .map((m) => m.slug)
      .sort();
    expect(optional).toEqual(["tender", "vendor-approval"]);
  });

  it("rejects an unknown category", () => {
    expect(() =>
      ModuleCatalogEntrySchema.parse({ ...MODULE_CATALOG[0], category: "x" }),
    ).toThrow();
  });
});

describe("syncModuleCatalog", () => {
  type Captured = {
    values: unknown;
    conflict: { set: Record<string, unknown> };
  };

  function recordingExecutor(): {
    executor: ModuleCatalogExecutor;
    calls: Captured[];
  } {
    const calls: Captured[] = [];
    const executor = {
      insert: () => ({
        values: (values: unknown) => ({
          onConflictDoUpdate: (conflict: Captured["conflict"]) => {
            calls.push({ values, conflict });
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as ModuleCatalogExecutor; // test double: only the insert().values().onConflictDoUpdate() chain is used
    return { executor, calls };
  }

  it("upserts every catalog entry, keyed on slug", async () => {
    const { executor, calls } = recordingExecutor();
    const n = await syncModuleCatalog(executor);
    expect(n).toBe(MODULE_CATALOG.length);
    expect(calls).toHaveLength(MODULE_CATALOG.length);
  });

  it("refreshes the catalog columns and never touches is_visible or created_at", async () => {
    const { executor, calls } = recordingExecutor();
    await syncModuleCatalog(executor);
    const refreshed = Object.keys(calls[0]?.conflict.set ?? {}).sort();
    expect(refreshed).toEqual(
      [
        "category",
        "description",
        "isSystem",
        "minPlan",
        "name",
        "updatedAt",
        "version",
      ].sort(),
    );
    for (const call of calls) {
      expect(call.values).not.toHaveProperty("isVisible");
      expect(call.conflict.set).not.toHaveProperty("isVisible");
      expect(call.conflict.set).not.toHaveProperty("createdAt");
    }
    // Guard against a renamed column silently dropping out of the sync.
    const columns = Object.keys(getTableColumns(modules));
    for (const key of refreshed) expect(columns).toContain(key);
  });
});
