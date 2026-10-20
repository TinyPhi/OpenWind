import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import { Readable } from "node:stream";

const mockGetJob = vi.fn();
const mockAdd = vi.fn();
const mockWriteAuditEntry = vi.fn();
const mockWithTenantContext = vi.fn();
const mockGetExportStream = vi.fn();
const mockRateLimit = vi.fn();
const mockMemberRows = vi.fn();
const requireRoleCalls: string[][] = [];

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => "sql"),
  eq: vi.fn(() => "sql"),
}));

vi.mock("@platform/files", () => {
  class FileError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  }
  return {
    FileError,
    USER_DATA_EXPORT_JOB_PREFIX: "userdata-",
    getExportStream: (...args: unknown[]) => mockGetExportStream(...args),
  };
});

vi.mock("@platform/config", () => ({ env: { USER_EXPORT_TTL_DAYS: 7 } }));

vi.mock("@platform/db", () => ({
  db: {},
  tenantUsers: { id: "id", tenantId: "tenantId", userId: "userId" },
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireRole:
    (...roles: string[]) =>
    async (c: Context, next: Next) => {
      requireRoleCalls.push(roles);
      const auth = c.get("auth") as AuthContext;
      if (!auth.roles.some((r) => roles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      await next();
      return;
    },
}));

vi.mock("../../lib/export-queue.js", () => ({
  exportQueue: {
    getJob: (...a: unknown[]) => mockGetJob(...a),
    add: (...a: unknown[]) => mockAdd(...a),
  },
  isUserDataExportPayload: (d: { kind?: string }) => d.kind === "user_data",
}));

vi.mock("../../lib/rate-limit-tiers.js", () => ({
  enforceExportRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

const { userExportRouter } = await import("./user-export.js");

const EXPORT_ID = "00000000-0000-4000-a000-000000000642";
const JOB_ID = `userdata-${EXPORT_ID}`;

function makeApp(roles = ["admin"], tenantId = "tenant-aaa") {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      tenantId,
      userId: "u-admin",
      roles,
      email: "a@b.com",
    } as AuthContext);
    await next();
  });
  app.route("/users", userExportRouter);
  return app;
}

function job(
  state: string,
  over: { tenantId?: string; subjectUserId?: string; finishedOn?: number } = {},
) {
  return {
    data: {
      kind: "user_data",
      tenantId: over.tenantId ?? "tenant-aaa",
      subjectUserId: over.subjectUserId ?? "u-subject",
      requestedBy: "u-admin",
    },
    returnvalue: { storageKey: `tenant-aaa/exports/${JOB_ID}.json` },
    finishedOn: over.finishedOn ?? Date.now(),
    getState: vi.fn().mockResolvedValue(state),
  };
}

const audits = (): Array<Record<string, unknown>> =>
  mockWriteAuditEntry.mock.calls.map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  mockWithTenantContext.mockImplementation(
    (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({ where: () => ({ limit: mockMemberRows }) }),
        }),
      }),
  );
  mockWriteAuditEntry.mockResolvedValue(undefined);
  mockRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
  mockMemberRows.mockResolvedValue([{ id: "row" }]);
  mockAdd.mockImplementation((_n: string, _d: unknown, o: { jobId: string }) =>
    Promise.resolve({ id: o.jobId }),
  );
  mockGetExportStream.mockResolvedValue({
    stream: Readable.from([Buffer.from("{}")]),
    originalName: `export-${JOB_ID}.json`,
    mimeType: "application/json",
    sizeBytes: 2,
  });
});

// withTenantContext is used for both the member lookup and audit writes; the
// lookup is the call whose callback receives a tx with select().
function memberLookupTx() {
  mockWithTenantContext.mockImplementation(
    (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({ where: () => ({ limit: mockMemberRows }) }),
        }),
      }),
  );
}

describe("POST /users/:userId/export", () => {
  it("enqueues a user_data job with TTL-bound retention and audits the request", async () => {
    memberLookupTx();
    const res = await makeApp().request("/users/u-subject/export", {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { jobId: string } };
    expect(body.data.jobId).toMatch(/^userdata-[0-9a-f-]{36}$/);
    const [name, payload, opts] = mockAdd.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(name).toBe("export");
    expect(payload).toEqual({
      kind: "user_data",
      tenantId: "tenant-aaa",
      subjectUserId: "u-subject",
      requestedBy: "u-admin",
    });
    expect(opts.removeOnComplete).toEqual({ age: 7 * 86_400 });
    expect(audits()[0]).toMatchObject({
      action: "export.requested",
      resourceType: "user_data_export",
      metadata: { subjectUserId: "u-subject", format: "json" },
    });
  });

  it("is admin-only", async () => {
    const res = await makeApp(["agent"]).request("/users/u-subject/export", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(requireRoleCalls.every((r) => r.join() === "admin")).toBe(true);
  });

  it("returns 404 and enqueues nothing for a user with no row in this tenant", async () => {
    memberLookupTx();
    mockMemberRows.mockResolvedValue([]);
    const res = await makeApp().request("/users/u-other-tenant/export", {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    mockRateLimit.mockResolvedValue({
      allowed: false,
      resetAt: Math.ceil(Date.now() / 1000) + 30,
    });
    const res = await makeApp().request("/users/u-subject/export", {
      method: "POST",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("rejects a malformed user id with 400", async () => {
    const res = await makeApp().request("/users/a%20b%3B/export", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("audits export.failed and rethrows when enqueue fails", async () => {
    memberLookupTx();
    mockAdd.mockRejectedValue(new Error("redis down"));
    const app = makeApp();
    app.onError((_e, c) => c.json({ error: "INTERNAL" }, 500));
    const res = await app.request("/users/u-subject/export", {
      method: "POST",
    });
    expect(res.status).toBe(500);
    expect(audits().map((a) => a.action)).toEqual([
      "export.requested",
      "export.failed",
    ]);
  });
});

describe("GET /users/:userId/export/:jobId/download", () => {
  const url = (q = "") => `/users/u-subject/export/${JOB_ID}/download${q}`;

  it("is admin-only", async () => {
    const res = await makeApp(["agent"]).request(url("?file=1"));
    expect(res.status).toBe(403);
    expect(mockGetJob).not.toHaveBeenCalled();
  });

  it("returns 404 for another tenant's job without auditing under this tenant", async () => {
    mockGetJob.mockResolvedValue(job("completed", { tenantId: "tenant-bbb" }));
    const res = await makeApp().request(url("?file=1"));
    expect(res.status).toBe(404);
    expect(mockGetExportStream).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 404 for an entity export job id", async () => {
    mockGetJob.mockResolvedValue({
      data: { tenantId: "tenant-aaa", entityTypeId: "e", format: "csv" },
      getState: vi.fn(),
    });
    const res = await makeApp().request(url("?file=1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 and audits a denial when the job is for a different user", async () => {
    mockGetJob.mockResolvedValue(
      job("completed", { subjectUserId: "u-someone-else" }),
    );
    const res = await makeApp().request(url("?file=1"));
    expect(res.status).toBe(404);
    expect(mockGetExportStream).not.toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ action: "export.download_denied" });
  });

  it("returns 404 once the subject has been erased, even for a finished bundle", async () => {
    mockGetJob.mockResolvedValue(job("completed"));
    mockMemberRows.mockResolvedValue([]);
    const res = await makeApp().request(url("?file=1"));
    expect(res.status).toBe(404);
    expect(mockGetExportStream).not.toHaveBeenCalled();
  });

  it("reports pending with 202", async () => {
    mockGetJob.mockResolvedValue(job("active"));
    const res = await makeApp().request(url());
    expect(res.status).toBe(202);
  });

  it("gives the admin download URL, not the entity-export one, and no path", async () => {
    mockGetJob.mockResolvedValue(job("completed"));
    const res = await makeApp().request(url());
    const text = await res.text();
    expect(text).toContain(`/users/u-subject/export/${JOB_ID}/download?file=1`);
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("tenant-aaa/exports");
  });

  it("audits then streams the file with no-store", async () => {
    mockGetJob.mockResolvedValue(job("completed"));
    const res = await makeApp().request(url("?file=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("{}");
    expect(mockGetExportStream).toHaveBeenCalledWith(
      "tenant-aaa",
      JOB_ID,
      "json",
      `tenant-aaa/exports/${JOB_ID}.json`,
    );
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: "export.downloaded",
      resourceId: EXPORT_ID,
      resourceType: "user_data_export",
    });
  });

  it("fails closed: no bytes when the audit write fails", async () => {
    mockGetJob.mockResolvedValue(job("completed"));
    mockWriteAuditEntry.mockRejectedValue(new Error("audit down"));
    const app = makeApp();
    app.onError((_e, c) => c.json({ error: "INTERNAL" }, 500));
    const res = await app.request(url("?file=1"));
    expect(res.status).toBe(500);
  });

  it("reports EXPORT_EXPIRED once the TTL has passed", async () => {
    mockGetJob.mockResolvedValue(
      job("completed", { finishedOn: Date.now() - 8 * 86_400_000 }),
    );
    const res = await makeApp().request(url("?file=1"));
    const body = (await res.json()) as { data: { error: string } };
    expect(body.data.error).toBe("EXPORT_EXPIRED");
    expect(mockGetExportStream).not.toHaveBeenCalled();
  });

  it("reports EXPORT_EXPIRED when the sweep already removed the file", async () => {
    const { FileError } = await import("@platform/files");
    mockGetJob.mockResolvedValue(job("completed"));
    mockGetExportStream.mockRejectedValue(
      new (FileError as unknown as new (c: string) => Error)(
        "STORAGE_READ_FAILED",
      ),
    );
    const res = await makeApp().request(url("?file=1"));
    const body = (await res.json()) as { data: { error: string } };
    expect(body.data.error).toBe("EXPORT_EXPIRED");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
