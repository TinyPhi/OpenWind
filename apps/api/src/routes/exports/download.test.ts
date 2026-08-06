import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetJob = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("../../lib/export-queue.js", () => ({
  exportQueue: { getJob: (...args: unknown[]) => mockGetJob(...args) },
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

const { exportsRouter } = await import("./download.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(tenantId = "tenant-aaa", userId = "u-001", roles = ["agent"]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", { tenantId, userId, roles, email: "a@b.com" });
    await next();
  });
  app.route("/exports", exportsRouter);
  return app;
}

function makeJob(
  state: string,
  opts: {
    tenantId?: string;
    requestedBy?: string;
    includePii?: boolean;
    returnvalue?: Record<string, unknown>;
  } = {},
) {
  const {
    tenantId = "tenant-aaa",
    requestedBy = "u-001",
    includePii = false,
    returnvalue,
  } = opts;
  return {
    data: { tenantId, requestedBy, includePii },
    returnvalue,
    getState: vi.fn().mockResolvedValue(state),
  };
}

beforeEach(() => vi.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /exports/:jobId/download", () => {
  it("returns 202 with status pending when job is active", async () => {
    mockGetJob.mockResolvedValue(makeJob("active"));
    const res = await makeApp().request("/exports/job-001/download");
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("pending");
  });

  it("returns 202 with status pending when job is waiting", async () => {
    mockGetJob.mockResolvedValue(makeJob("waiting"));
    const res = await makeApp().request("/exports/job-001/download");
    expect(res.status).toBe(202);
  });

  it("returns 200 with downloadUrl when job is completed", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", {
        returnvalue: {
          downloadUrl: "https://s3.example.com/exports/tenant-aaa/job-001.csv",
          format: "csv",
          rowCount: 1234,
        },
      }),
    );
    const res = await makeApp().request("/exports/job-001/download");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; downloadUrl: string };
    };
    expect(body.data.status).toBe("complete");
    expect(body.data.downloadUrl).toContain("s3.example.com");
  });

  it("returns 200 with EXPORT_EXPIRED when completed job returnvalue is null (TTL expired)", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", { returnvalue: undefined }),
    );
    const res = await makeApp().request("/exports/job-001/download");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; error: string };
    };
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toBe("EXPORT_EXPIRED");
  });

  it("returns 200 with TENANT_DEACTIVATED when completed job has error property in returnvalue", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", { returnvalue: { error: "TENANT_DEACTIVATED" } }),
    );
    const res = await makeApp().request("/exports/job-001/download");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; error: string };
    };
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toBe("TENANT_DEACTIVATED");
  });

  it("returns 200 with status failed when job has failed (allows client polling branch to work)", async () => {
    mockGetJob.mockResolvedValue(makeJob("failed"));
    const res = await makeApp().request("/exports/job-001/download");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; error: string };
    };
    expect(body.data.status).toBe("failed");
    expect(body.data.error).toBe("EXPORT_FAILED");
  });

  it("returns 404 when job does not exist", async () => {
    mockGetJob.mockResolvedValue(null);
    const res = await makeApp().request("/exports/nonexistent/download");
    expect(res.status).toBe(404);
  });

  it("returns 404 when job belongs to a different tenant", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", { tenantId: "tenant-bbb" }),
    );
    const res = await makeApp("tenant-aaa").request(
      "/exports/job-other-tenant/download",
    );
    expect(res.status).toBe(404);
  });

  // ── PII gate tests ────────────────────────────────────────────────────────────

  it("allows original requester to poll their own pii export even without pii role", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", {
        requestedBy: "u-001",
        includePii: true,
        returnvalue: { downloadUrl: "https://s3.example.com/pii.csv" },
      }),
    );
    // u-001 with role "agent" (no pii_export) — but they are the original requester
    const res = await makeApp("tenant-aaa", "u-001", ["agent"]).request(
      "/exports/job-pii/download",
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when a different user without pii role polls a pii export", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", {
        requestedBy: "u-001",
        includePii: true,
        returnvalue: { downloadUrl: "https://s3.example.com/pii.csv" },
      }),
    );
    // u-002 with role "agent" — different user, no pii_export
    const res = await makeApp("tenant-aaa", "u-002", ["agent"]).request(
      "/exports/job-pii/download",
    );
    expect(res.status).toBe(404);
  });

  it("allows a user with pii_export role to poll another user's pii export", async () => {
    mockGetJob.mockResolvedValue(
      makeJob("completed", {
        requestedBy: "u-001",
        includePii: true,
        returnvalue: { downloadUrl: "https://s3.example.com/pii.csv" },
      }),
    );
    // u-002 with pii_export role — different user but holds PII role
    const res = await makeApp("tenant-aaa", "u-002", ["pii_export"]).request(
      "/exports/job-pii/download",
    );
    expect(res.status).toBe(200);
  });
});
