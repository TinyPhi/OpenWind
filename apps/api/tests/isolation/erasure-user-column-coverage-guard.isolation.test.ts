/**
 * Drift guard (#635, docs/specs/gdpr-erasure-coverage.md R5): every column on a
 * tenant-scoped base table that follows a user-reference naming convention must
 * be scrubbed by per-user erasure or explicitly exempted with a reason. Adding
 * such a column without wiring it into src/services/user-erasure.ts fails here.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@platform/db";
import {
  USER_REFERENCE_COLUMNS_HANDLED,
  USER_REFERENCE_COLUMNS_EXEMPT,
} from "../../src/services/user-erasure.js";

// Naming conventions for columns holding a (Zitadel) user id.
const USER_REFERENCE_PATTERN =
  "(^|_)(created_by|updated_by|deleted_by|assigned_to|assigned_by|actor_id|acting_person_id|requester_id|resolved_by|revoked_by|disabled_by|uploaded_by|triggered_by|granted_by|approved_by|owner_id|recipient_id|user_id|recipients_snapshot)$|_user_id$";

async function userReferenceColumns(): Promise<string[]> {
  const rows = await db.execute<{ ref: string }>(sql`
    SELECT c.table_name || '.' || c.column_name AS ref
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.table_name IN (
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
      )
      AND c.column_name ~ ${USER_REFERENCE_PATTERN}
    ORDER BY 1`);
  return rows.map((r) => r.ref);
}

describe("erasure coverage guard — user-reference columns", () => {
  it("every user-reference column is erased or exempted with a reason", async () => {
    const known = new Set([
      ...USER_REFERENCE_COLUMNS_HANDLED,
      ...Object.keys(USER_REFERENCE_COLUMNS_EXEMPT),
    ]);
    const uncovered = (await userReferenceColumns()).filter(
      (c) => !known.has(c),
    );
    expect(
      uncovered,
      "add these to user-erasure.ts (USER_REFERENCE_COLUMNS_HANDLED + a statement) or USER_REFERENCE_COLUMNS_EXEMPT",
    ).toEqual([]);
  });

  it("never both erases and exempts the same column", () => {
    const both = USER_REFERENCE_COLUMNS_HANDLED.filter(
      (c) => c in USER_REFERENCE_COLUMNS_EXEMPT,
    );
    expect(both).toEqual([]);
  });
});
