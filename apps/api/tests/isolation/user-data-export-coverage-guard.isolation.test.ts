/**
 * #642 / docs/specs/user-data-export.md: drift guard, modelled on
 * erasure-user-column-coverage-guard. Every column in the erasure inventory
 * (handled or exempt) is either collected by the data-subject export or
 * excluded from it with a stated reason, so a new user-reference column that
 * lands in the erasure inventory cannot silently stay out of an Art. 15 export.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@platform/db";
import {
  userDataExportCollectedColumns,
  USER_DATA_EXPORT_EXCLUDED_COLUMNS,
} from "@platform/entity-engine";
import {
  USER_REFERENCE_COLUMNS_HANDLED,
  USER_REFERENCE_COLUMNS_EXEMPT,
} from "../../src/services/user-erasure.js";

const inventory = [
  ...USER_REFERENCE_COLUMNS_HANDLED,
  ...Object.keys(USER_REFERENCE_COLUMNS_EXEMPT),
];

describe("user data export coverage guard (#642)", () => {
  it("every erasure-inventory column is collected or excluded with a reason", () => {
    const known = new Set([
      ...userDataExportCollectedColumns(),
      ...Object.keys(USER_DATA_EXPORT_EXCLUDED_COLUMNS),
    ]);
    const uncovered = inventory.filter((c) => !known.has(c));
    expect(
      uncovered,
      "collect these in packages/entity-engine/src/user-data-export.ts or add them to USER_DATA_EXPORT_EXCLUDED_COLUMNS with a reason",
    ).toEqual([]);
  });

  it("every exclusion states a reason", () => {
    for (const [column, reason] of Object.entries(
      USER_DATA_EXPORT_EXCLUDED_COLUMNS,
    )) {
      expect(reason.trim().length, column).toBeGreaterThan(20);
    }
  });

  it("never both collects and excludes the same column", () => {
    expect(
      userDataExportCollectedColumns().filter(
        (c) => c in USER_DATA_EXPORT_EXCLUDED_COLUMNS,
      ),
    ).toEqual([]);
  });

  it("everything it collects or excludes still exists in the schema", async () => {
    const rows = await db.execute<{ ref: string }>(sql`
      SELECT table_name || '.' || column_name AS ref
      FROM information_schema.columns WHERE table_schema = 'public'`);
    const existing = new Set(rows.map((r) => r.ref));
    const missing = [
      ...userDataExportCollectedColumns(),
      ...Object.keys(USER_DATA_EXPORT_EXCLUDED_COLUMNS),
    ].filter((c) => !existing.has(c));
    expect(missing).toEqual([]);
  });
});
