import { describe, it, expect, vi, beforeEach } from "vitest";

// docs/specs/mandatory-ticket-fields.md R7 (owner decision 2026-10-16): the workflow's
// creator, then its workflow admins (current members only, never erased), then the tenant's
// longest-standing admin.

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn((_col: unknown, values: unknown) => ({ values })),
  isNull: vi.fn(),
  or: vi.fn(),
}));

vi.mock("@platform/db", () => ({
  tenants: { id: "id", zitadelOrgId: "zitadel_org_id" },
  tenantUsers: { tenantId: "tenant_id", userId: "user_id", createdAt: "c" },
  workflows: { id: "id", tenantId: "t", createdBy: "cb", assignedTo: "at" },
}));

const mockListUserIdsWithRole = vi.fn();
vi.mock("@platform/auth", () => ({
  listUserIdsWithRole: (...args: unknown[]) =>
    mockListUserIdsWithRole(...args) as unknown,
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { resolveFallbackAssignee } = await import("./fallback-assignee.js");

// Each select() answers with the next queued result, in query order.
let results: unknown[][] = [];
function fakeDb(): unknown {
  const chain = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy"]) q[m] = () => q;
    q["then"] = (resolve: (v: unknown[]) => void) =>
      Promise.resolve(results.shift() ?? []).then(resolve);
    return q;
  };
  return { select: () => chain() };
}

beforeEach(() => {
  vi.clearAllMocks();
  results = [];
  mockListUserIdsWithRole.mockResolvedValue(new Set(["admin-1", "admin-2"]));
});

describe("resolveFallbackAssignee", () => {
  it("prefers the workflow's creator when they're a member", async () => {
    results = [
      [{ createdBy: "creator", admins: ["wf-admin"] }],
      [{ userId: "creator" }, { userId: "wf-admin" }],
    ];
    expect(
      await resolveFallbackAssignee(fakeDb() as never, "t-1", "wf-1"),
    ).toBe("creator");
  });

  it("skips an erased or departed creator for the first member workflow admin", async () => {
    results = [
      [{ createdBy: "[REDACTED]", admins: ["gone", "wf-admin"] }],
      [{ userId: "wf-admin" }],
    ];
    expect(
      await resolveFallbackAssignee(fakeDb() as never, "t-1", "wf-1"),
    ).toBe("wf-admin");
  });

  it("falls back to the tenant's longest-standing admin when the workflow has no owner", async () => {
    results = [
      [{ createdBy: null, admins: null }],
      [{ orgId: "org-1" }],
      [{ userId: "admin-2" }],
    ];
    expect(
      await resolveFallbackAssignee(fakeDb() as never, "t-1", "wf-1"),
    ).toBe("admin-2");
    expect(mockListUserIdsWithRole).toHaveBeenCalledWith("org-1", "admin");
  });

  it("goes straight to the admin when there's no workflow", async () => {
    results = [[{ orgId: "org-1" }], [{ userId: "admin-1" }]];
    expect(await resolveFallbackAssignee(fakeDb() as never, "t-1", null)).toBe(
      "admin-1",
    );
  });

  it.each([
    ["the tenant has no Zitadel org", [[{ orgId: null }]], undefined],
    ["Zitadel can't be reached", [[{ orgId: "org-1" }]], "error"],
    ["no admin has joined the tenant", [[{ orgId: "org-1" }], []], undefined],
  ])("returns null when %s", async (_why, queued, failure) => {
    results = queued as unknown[][];
    if (failure) mockListUserIdsWithRole.mockRejectedValue(new Error("down"));
    expect(
      await resolveFallbackAssignee(fakeDb() as never, "t-1", null),
    ).toBeNull();
  });
});
