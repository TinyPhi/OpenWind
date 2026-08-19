import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbOrTx } from "@platform/db";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("@platform/db", () => ({
  entityFields: {
    name: "entity_fields.name",
    entityTypeId: "entity_fields.entity_type_id",
    fieldType: "entity_fields.field_type",
  },
  tenantUsers: {
    userId: "tenant_users.user_id",
    tenantId: "tenant_users.tenant_id",
  },
}));

const mockListOrgUsers = vi.fn();
vi.mock("./zitadel-management.js", () => ({
  listOrgUsers: (...args: unknown[]) => mockListOrgUsers(...args),
}));

const { ensureUserRefsKnown } = await import("./ensure-user-refs.js");

// ── Test double ───────────────────────────────────────────────────────────────

/**
 * Queues up SELECT results in call order (first select() call gets
 * `selectResults[0]`, second gets `selectResults[1]`, etc.) and records every
 * `insert().values(...)` call for assertions.
 */
function makeMockTx(selectResults: unknown[][]): {
  tx: DbOrTx;
  insertedValues: Record<string, unknown>[];
} {
  let selectCall = 0;
  const insertedValues: Record<string, unknown>[] = [];
  const tx = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(selectResults[selectCall++] ?? []),
      }),
    })),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  } as unknown as DbOrTx;
  return { tx, insertedValues };
}

const TENANT_ID = "tenant-abc";
const ENTITY_TYPE_ID = "type-1";
const ORG_ID = "org-xyz";

beforeEach(() => {
  mockListOrgUsers.mockReset();
});

describe("ensureUserRefsKnown", () => {
  it("upserts tenant_users for a user_ref value that's a real org member not yet known locally", async () => {
    const { tx, insertedValues } = makeMockTx([
      [{ name: "reviewer" }], // entity_fields (user_ref field names)
      [], // tenant_users (none already known)
    ]);
    mockListOrgUsers.mockResolvedValue([
      {
        userId: "u-new",
        email: "u-new@example.com",
        displayName: "New User",
        loginName: "u-new",
      },
    ]);

    await ensureUserRefsKnown(
      tx,
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-new" },
      ORG_ID,
    );

    expect(mockListOrgUsers).toHaveBeenCalledWith(ORG_ID);
    expect(insertedValues).toEqual([
      {
        tenantId: TENANT_ID,
        userId: "u-new",
        email: "u-new@example.com",
        displayName: "New User",
      },
    ]);
  });

  it("does not insert for a value that isn't a real org member - leaves entity-engine's own check to reject it", async () => {
    const { tx, insertedValues } = makeMockTx([[{ name: "reviewer" }], []]);
    mockListOrgUsers.mockResolvedValue([]); // not an org member

    await ensureUserRefsKnown(
      tx,
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-not-a-member" },
      ORG_ID,
    );

    expect(insertedValues).toEqual([]);
  });

  it("skips the org-membership call entirely when the value is already in tenant_users", async () => {
    const { tx, insertedValues } = makeMockTx([
      [{ name: "reviewer" }],
      [{ userId: "u-known" }], // already known locally
    ]);

    await ensureUserRefsKnown(
      tx,
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-known" },
      ORG_ID,
    );

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
  });

  it("skips entirely when the entity type has no user_ref fields", async () => {
    const { tx, insertedValues } = makeMockTx([[]]);

    await ensureUserRefsKnown(
      tx,
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-anything" },
      ORG_ID,
    );

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
  });

  it("skips entirely when orgId is undefined (fail closed, no Zitadel call)", async () => {
    const { tx, insertedValues } = makeMockTx([[{ name: "reviewer" }], []]);

    await ensureUserRefsKnown(
      tx,
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-anything" },
      undefined,
    );

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
  });
});
