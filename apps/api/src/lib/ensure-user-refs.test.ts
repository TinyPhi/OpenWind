import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbOrTx } from "@platform/db";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));

const mockTenantTx = vi.hoisted(() => ({ current: undefined as unknown }));
const ctxDepth = vi.hoisted(() => ({ current: 0 }));
vi.mock("@platform/db", () => ({
  withTenantContext: async (
    _tenantId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    ctxDepth.current++;
    try {
      return await fn(mockTenantTx.current);
    } finally {
      ctxDepth.current--;
    }
  },
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

const { ensureUserRefsKnown, ensureTenantMembers, resolveTenantMembers } =
  await import("./ensure-user-refs.js");

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
    mockTenantTx.current = tx;
    mockListOrgUsers.mockResolvedValue([
      {
        userId: "u-new",
        email: "u-new@example.com",
        displayName: "New User",
        loginName: "u-new",
      },
    ]);

    await ensureUserRefsKnown(
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
    mockTenantTx.current = tx;
    mockListOrgUsers.mockResolvedValue([]); // not an org member

    await ensureUserRefsKnown(
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
    mockTenantTx.current = tx;

    await ensureUserRefsKnown(
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-known" },
      ORG_ID,
    );

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
    mockTenantTx.current = tx;
  });

  it("skips entirely when the entity type has no user_ref fields", async () => {
    const { tx, insertedValues } = makeMockTx([[]]);
    mockTenantTx.current = tx;

    await ensureUserRefsKnown(
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
    mockTenantTx.current = tx;

    await ensureUserRefsKnown(
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-anything" },
      undefined,
    );

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
  });

  it("calls Zitadel outside any tenant context and upserts in a later one", async () => {
    const { tx } = makeMockTx([[{ name: "reviewer" }], []]);
    mockTenantTx.current = tx;
    let depthAtZitadel = -1;
    mockListOrgUsers.mockImplementation(() => {
      depthAtZitadel = ctxDepth.current;
      return Promise.resolve([
        { userId: "u-new", email: "", displayName: "", loginName: "u-new" },
      ]);
    });

    await ensureUserRefsKnown(
      TENANT_ID,
      ENTITY_TYPE_ID,
      { reviewer: "u-new" },
      ORG_ID,
    );

    expect(depthAtZitadel).toBe(0);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });
});

describe("ensureTenantMembers", () => {
  const orgUser = (userId: string): Record<string, string> => ({
    userId,
    email: `${userId}@example.com`,
    displayName: userId,
    loginName: userId,
  });

  it("returns existing members and adds org members who never signed in", async () => {
    const { tx, insertedValues } = makeMockTx([[{ userId: "u-known" }]]);
    mockListOrgUsers.mockResolvedValue([orgUser("u-new")]);

    const members = await ensureTenantMembers(
      tx,
      TENANT_ID,
      ["u-known", "u-new"],
      ORG_ID,
    );

    expect([...members].sort()).toEqual(["u-known", "u-new"]);
    expect(insertedValues).toEqual([
      {
        tenantId: TENANT_ID,
        userId: "u-new",
        email: "u-new@example.com",
        displayName: "u-new",
      },
    ]);
  });

  it("never adds or returns an id outside the tenant's org", async () => {
    const { tx, insertedValues } = makeMockTx([[]]);
    mockListOrgUsers.mockResolvedValue([orgUser("u-member")]);

    const members = await ensureTenantMembers(
      tx,
      TENANT_ID,
      ["u-outsider"],
      ORG_ID,
    );

    expect(members.size).toBe(0);
    expect(insertedValues).toEqual([]);
  });

  it("without an orgId, counts only existing rows and never calls Zitadel", async () => {
    const { tx, insertedValues } = makeMockTx([[{ userId: "u-known" }]]);

    const members = await ensureTenantMembers(
      tx,
      TENANT_ID,
      ["u-known", "u-new"],
      undefined,
    );

    expect([...members]).toEqual(["u-known"]);
    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
  });

  it("treats a Zitadel failure as 'not a member' rather than throwing", async () => {
    const { tx, insertedValues } = makeMockTx([[]]);
    mockListOrgUsers.mockRejectedValue(new Error("zitadel down"));

    const members = await ensureTenantMembers(tx, TENANT_ID, ["u-new"], ORG_ID);

    expect(members.size).toBe(0);
    expect(insertedValues).toEqual([]);
  });

  it("does nothing for an empty list", async () => {
    const { tx } = makeMockTx([]);

    const members = await ensureTenantMembers(tx, TENANT_ID, [], ORG_ID);

    expect(members.size).toBe(0);
    expect(tx.select).not.toHaveBeenCalled();
  });
});

describe("resolveTenantMembers", () => {
  it("calls Zitadel with no tenant context open, between two short ones", async () => {
    const events: string[] = [];
    const { tx } = makeMockTx([[], []]);
    mockTenantTx.current = new Proxy(tx as object, {
      get(target, prop, receiver) {
        if (prop === "select") events.push("read");
        if (prop === "insert") events.push("write");
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    mockListOrgUsers.mockImplementation(() => {
      events.push("zitadel");
      return Promise.resolve([
        {
          userId: "u-new",
          email: "u-new@example.com",
          displayName: "New",
          loginName: "u-new",
        },
      ]);
    });

    const members = await resolveTenantMembers(
      TENANT_ID,
      ["u-new", "u-stranger"],
      ORG_ID,
    );

    expect(events).toEqual(["read", "zitadel", "write"]);
    expect([...members]).toEqual(["u-new"]);
  });

  it("makes no Zitadel call when everyone is already a member", async () => {
    const { tx } = makeMockTx([[{ userId: "u-1" }]]);
    mockTenantTx.current = tx;

    const members = await resolveTenantMembers(TENANT_ID, ["u-1"], ORG_ID);

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect([...members]).toEqual(["u-1"]);
  });

  it("fails closed without an orgId: only existing rows count, no Zitadel call", async () => {
    const { tx } = makeMockTx([[]]);
    mockTenantTx.current = tx;

    const members = await resolveTenantMembers(TENANT_ID, ["u-x"], undefined);

    expect(mockListOrgUsers).not.toHaveBeenCalled();
    expect(members.size).toBe(0);
  });
});
