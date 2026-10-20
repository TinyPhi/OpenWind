import { describe, it, expect } from "vitest";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@platform/db";
import {
  collectUserDataBundle,
  serializeUserDataBundle,
  userDataExportSectionColumns,
  userDataExportCollectedColumns,
  USER_DATA_EXPORT_EXCLUDED_COLUMNS,
} from "./user-data-export.js";
import { isUserDataExportPayload } from "./export-utils.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

// Columns that must never appear in a bundle, whatever table they are on.
const SECRET_COLUMNS = [
  "key_hash",
  "key_hash_argon2",
  "secrets",
  "cursor_state",
  "upload_token_hash",
  "storage_key",
  "content_hash",
  "response_body",
  "search_vector",
  "before_snapshot",
  "after_snapshot",
];

function fakeTx(rowsByTable: Record<string, Record<string, unknown>[]>): {
  tx: DbOrTx;
  queried: string[];
  executed: string[];
} {
  const queried: string[] = [];
  const executed: string[] = [];
  let table = "";
  const result = (): Promise<Record<string, unknown>[]> =>
    Promise.resolve(rowsByTable[table] ?? []);
  const tx = {
    select: () => ({
      from: (t: PgTable) => {
        table = getTableName(t);
        queried.push(table);
        return {
          where: () => ({
            orderBy: () => ({
              limit: result,
              then: (
                ok: (v: Record<string, unknown>[]) => unknown,
                err: (e: unknown) => unknown,
              ) => result().then(ok, err),
            }),
          }),
        };
      },
    }),
    execute: () => {
      executed.push("execute");
      return Promise.resolve([{ current: null }]);
    },
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  // Test double for the narrow query surface the collector uses.
  return { tx: tx as unknown as DbOrTx, queried, executed };
}

describe("user data export inventory", () => {
  it("derives table.column references with no overlap between collected and excluded", () => {
    for (const ref of userDataExportCollectedColumns()) {
      expect(ref).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
    const overlap = userDataExportCollectedColumns().filter(
      (c) => c in USER_DATA_EXPORT_EXCLUDED_COLUMNS,
    );
    expect(overlap).toEqual([]);
    for (const reason of Object.values(USER_DATA_EXPORT_EXCLUDED_COLUMNS)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("never selects a secret column", () => {
    for (const [section, cols] of Object.entries(
      userDataExportSectionColumns(),
    )) {
      for (const col of cols) {
        if (section === "auditLog" && col === "metadata") continue;
        expect(SECRET_COLUMNS, `${section}.${col}`).not.toContain(col);
        expect(col.startsWith("?"), `${section}.${col} must exist`).toBe(false);
      }
    }
  });
});

describe("collectUserDataBundle", () => {
  const base = {
    tenantId: TENANT,
    userId: "user-1",
    rowLimit: 2,
    includeAudit: true,
    now: new Date("2026-10-20T00:00:00.000Z"),
  };

  it("truncates a section at the row limit and records it", async () => {
    const { tx } = fakeTx({
      labels: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    const bundle = await collectUserDataBundle(tx, base);
    expect(bundle.data.labels).toHaveLength(2);
    expect(bundle.metadata.truncated).toEqual(["labels"]);
  });

  it("strips the access list from entity fields", async () => {
    const { tx } = fakeTx({
      entity_instances: [
        { id: "i1", fields: { subject: "x", __accessUsers: ["other"] } },
      ],
    });
    const bundle = await collectUserDataBundle(tx, base);
    expect(bundle.data.entityInstances?.[0]?.fields).toEqual({ subject: "x" });
  });

  it("skips the audit section when disabled and says so", async () => {
    const { tx, queried } = fakeTx({});
    const bundle = await collectUserDataBundle(tx, {
      ...base,
      includeAudit: false,
    });
    expect(queried).not.toContain("admin_audit_log");
    expect(bundle.data.auditLog).toBeUndefined();
    expect(bundle.metadata.exclusions.auditLog).toMatch(/INCLUDE_AUDIT/);
  });

  it("queries the audit log when enabled", async () => {
    const { tx, queried } = fakeTx({});
    await collectUserDataBundle(tx, base);
    expect(queried).toContain("admin_audit_log");
  });

  it("reads saved_views inside a savepoint that sets and restores the GUC", async () => {
    const { tx, executed } = fakeTx({});
    await collectUserDataBundle(tx, base);
    expect(executed).toHaveLength(3);
  });

  it("loads notification content for the subject's recipient rows only", async () => {
    const { tx, queried } = fakeTx({
      notification_recipients: [{ id: "r1", notificationId: "n1" }],
      notifications: [{ id: "n1", title: "t" }],
    });
    const bundle = await collectUserDataBundle(tx, base);
    expect(queried).toContain("notifications");
    expect(bundle.data.notifications).toEqual([{ id: "n1", title: "t" }]);
  });

  it("sets availableUntil from the TTL", async () => {
    const { tx } = fakeTx({});
    const bundle = await collectUserDataBundle(tx, { ...base, ttlDays: 7 });
    expect(bundle.metadata.availableUntil).toBe("2026-10-27T00:00:00.000Z");
  });

  it("serializes bigint values as strings", () => {
    const out = serializeUserDataBundle({
      metadata: {
        schemaVersion: 1,
        tenantId: TENANT,
        subjectUserId: "u",
        generatedAt: "x",
        availableUntil: null,
        rowLimit: 1,
        includeAudit: true,
        truncated: [],
        exclusions: {},
      },
      data: { files: [{ sizeBytes: 12n }] },
    });
    expect(JSON.parse(out.toString("utf-8")).data.files[0].sizeBytes).toBe(
      "12",
    );
  });
});

describe("isUserDataExportPayload", () => {
  it("tells the two payload kinds apart", () => {
    expect(
      isUserDataExportPayload({
        kind: "user_data",
        tenantId: "t",
        subjectUserId: "u",
        requestedBy: "a",
      }),
    ).toBe(true);
    expect(
      isUserDataExportPayload({
        tenantId: "t",
        entityTypeId: "e",
        format: "csv",
        filters: {},
        requestedBy: "a",
      }),
    ).toBe(false);
  });
});
