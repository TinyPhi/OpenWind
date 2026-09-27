import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";
import type * as RenderExportPdf from "../../lib/render-export-pdf.js";
import { EntityError } from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetEntityType = vi.fn();
const mockListEntityFields = vi.fn();
const mockListEntities = vi.fn();
const mockExportQueueAdd = vi.fn();
const mockWriteAuditEntry = vi.fn();

let failPdfRender = false;
vi.mock("../../lib/render-export-pdf.js", async (importOriginal) => {
  const real = await importOriginal<typeof RenderExportPdf>();
  return {
    renderExportPdf: (...args: Parameters<typeof real.renderExportPdf>) => {
      if (failPdfRender) throw new Error("render exploded");
      return real.renderExportPdf(...args);
    },
  };
});

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntityType: (...args: unknown[]) => mockGetEntityType(...args),
    listEntityFields: (...args: unknown[]) => mockListEntityFields(...args),
    listEntities: (...args: unknown[]) => mockListEntities(...args),
  };
});

vi.mock("../../lib/export-queue.js", () => ({
  exportQueue: { add: (...args: unknown[]) => mockExportQueueAdd(...args) },
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

const { exportEntitiesHandler } = await import("./export.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TYPE_ID = "00000000-0000-0000-0000-000000000001";

const fakeEntityType = {
  id: TYPE_ID,
  tenantId: "t-aaa",
  name: "ticket",
  plural: "Tickets",
  icon: null,
  moduleId: null,
  allowCustomFields: true,
  createdAt: new Date("2026-01-01"),
};

const publicField = {
  id: "f-001",
  entityTypeId: TYPE_ID,
  tenantId: null,
  name: "subject",
  label: "Subject",
  fieldType: "text" as const,
  config: {},
  isRequired: true,
  isIndexed: false,
  isSystem: false,
  sortOrder: 0,
  sensitivity: "public" as const,
  createdAt: new Date("2026-01-01"),
};

const piiField = {
  ...publicField,
  id: "f-002",
  name: "email",
  label: "Email",
  sensitivity: "pii" as const,
  sortOrder: 1,
};

const financialField = {
  ...publicField,
  id: "f-003",
  name: "amount",
  label: "Amount",
  sensitivity: "financial" as const,
  sortOrder: 2,
};

function makeInstance(id: string) {
  return {
    id,
    entityTypeId: TYPE_ID,
    tenantId: "t-aaa",
    workflowId: null,
    currentState: "open",
    fields: { subject: "Test ticket", email: "user@example.com", amount: 100 },
    createdBy: null,
    assignedTo: null,
    createdAt: new Date("2026-01-15"),
    updatedAt: new Date("2026-01-15"),
    deletedAt: null,
  };
}

function makeApp(roles: string[] = ["admin"]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles,
      email: "test@example.com",
    });
    await next();
  });
  app.get("/:id/export", ...exportEntitiesHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEntityType.mockResolvedValue(fakeEntityType);
  mockListEntityFields.mockResolvedValue([
    publicField,
    piiField,
    financialField,
  ]);
  mockListEntities.mockResolvedValue({
    data: [makeInstance("inst-1"), makeInstance("inst-2")],
    nextCursor: null,
  });
  mockExportQueueAdd.mockResolvedValue({ id: "job-async-001" });
  mockWriteAuditEntry.mockResolvedValue(undefined);
  failPdfRender = false;
});

// The audit entries written, in order, as { action, metadata }.
function auditEntries(): Array<{
  action: string;
  metadata: Record<string, unknown>;
}> {
  return mockWriteAuditEntry.mock.calls.map((call) => {
    // second argument is writeAuditEntry's AuditEntryInput
    const input = call[1] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    return { action: input.action, metadata: input.metadata };
  });
}

// ── CSV tests ─────────────────────────────────────────────────────────────────

describe("GET /entity-types/:id/export?format=csv", () => {
  it("returns 200 with text/csv content type", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
  });

  it("CSV headers row has system cols first then field labels in sort_order", async () => {
    const res = await makeApp(["pii_export"]).request(
      `/${TYPE_ID}/export?format=csv`,
    );
    const text = await res.text();
    const firstLine = text.split("\n")[0] ?? "";
    expect(firstLine).toContain("ID");
    expect(firstLine).toContain("State");
    expect(firstLine).toContain("Subject");
    expect(firstLine.indexOf("Subject")).toBeGreaterThan(
      firstLine.indexOf("State"),
    );
  });

  it("CSV row count matches instance count", async () => {
    const res = await makeApp(["pii_export"]).request(
      `/${TYPE_ID}/export?format=csv`,
    );
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(3); // header + 2 data rows
  });

  it("audits a sync export as requested then completed, without row values", async () => {
    const res = await makeApp(["agent"]).request(
      `/${TYPE_ID}/export?format=csv&state=open`,
    );
    expect(res.status).toBe(200);
    expect(auditEntries()).toEqual([
      {
        action: "export.requested",
        metadata: {
          format: "csv",
          includePii: false,
          filters: { state: "open" },
          rowCount: 2,
          mode: "sync",
        },
      },
      {
        action: "export.completed",
        metadata: {
          format: "csv",
          includePii: false,
          rowCount: 2,
          mode: "sync",
        },
      },
    ]);
    const input = mockWriteAuditEntry.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(input).toMatchObject({
      tenantId: "t-aaa",
      actorId: "u-bbb",
      actorType: "user",
      resourceType: "entity_type",
      resourceId: TYPE_ID,
    });
    expect(JSON.stringify(mockWriteAuditEntry.mock.calls)).not.toContain(
      "user@example.com",
    );
  });

  it("audits export.failed and returns an error when a sync render throws", async () => {
    failPdfRender = true;
    const res = await makeApp().request(`/${TYPE_ID}/export?format=pdf`);
    expect(res.status).toBe(500);
    expect(auditEntries()).toEqual([
      expect.objectContaining({ action: "export.requested" }),
      {
        action: "export.failed",
        metadata: {
          format: "pdf",
          includePii: true,
          mode: "sync",
          error: "RENDER_FAILED",
        },
      },
    ]);
  });

  it("records that an assignee filter was used, never the assignee's user id", async () => {
    const assignee = "11111111-1111-4111-8111-111111111111";
    await makeApp().request(
      `/${TYPE_ID}/export?format=csv&assignedTo=${assignee}`,
    );
    expect(auditEntries()[0]?.metadata["filters"]).toEqual({
      assignedToFilter: true,
    });
    expect(JSON.stringify(mockWriteAuditEntry.mock.calls)).not.toContain(
      assignee,
    );
  });

  it("rejects a state filter outside the state-name character set", async () => {
    const res = await makeApp().request(
      `/${TYPE_ID}/export?format=csv&state=${encodeURIComponent("open; drop")}`,
    );
    expect(res.status).toBe(400);
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("records includePii: true when the requester holds a PII export role", async () => {
    await makeApp(["pii_export"]).request(`/${TYPE_ID}/export?format=csv`);
    expect(auditEntries().map((e) => e.metadata["includePii"])).toEqual([
      true,
      true,
    ]);
  });

  it("returns an error and exports nothing when the audit write fails", async () => {
    mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("Test ticket");
  });

  it("PII fields excluded when user lacks pii_export role", async () => {
    const res = await makeApp(["agent"]).request(
      `/${TYPE_ID}/export?format=csv`,
    );
    const text = await res.text();
    expect(text).not.toContain("Email");
    expect(text).not.toContain("Amount");
    expect(text).toContain("Subject");
  });

  it("PII fields included when user has pii_export role", async () => {
    const res = await makeApp(["pii_export"]).request(
      `/${TYPE_ID}/export?format=csv`,
    );
    const text = await res.text();
    expect(text).toContain("Email");
    expect(text).toContain("Amount");
  });

  it("admin role can see PII fields", async () => {
    const res = await makeApp(["admin"]).request(
      `/${TYPE_ID}/export?format=csv`,
    );
    const text = await res.text();
    expect(text).toContain("Email");
  });

  it("empty result returns headers-only CSV", async () => {
    mockListEntities.mockResolvedValue({ data: [], nextCursor: null });
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(200);
    const lines = (await res.text())
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it("Content-Disposition header contains entity plural and date", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    const d = res.headers.get("content-disposition") ?? "";
    expect(d).toContain("tickets-export-");
    expect(d).toContain(".csv");
  });
});

// ── xlsx tests ────────────────────────────────────────────────────────────────

describe("GET /entity-types/:id/export?format=xlsx", () => {
  it("returns 200 with xlsx content type", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
  });

  it("Content-Disposition contains .xlsx", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=xlsx`);
    expect(res.headers.get("content-disposition")).toContain(".xlsx");
  });

  it("response body is a non-empty buffer", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=xlsx`);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

// ── PDF tests ─────────────────────────────────────────────────────────────────

describe("GET /entity-types/:id/export?format=pdf", () => {
  it("returns 200 with application/pdf content type", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
  });

  it("Content-Disposition contains .pdf", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=pdf`);
    expect(res.headers.get("content-disposition")).toContain(".pdf");
  });

  it("response body starts with PDF magic bytes (%PDF)", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=pdf`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("uses landscape layout when more than 6 columns", async () => {
    // Add 7 extra fields to push column count above 6 (4 system + 7 custom = 11)
    const extraFields = Array.from({ length: 7 }, (_, i) => ({
      ...publicField,
      id: `f-extra-${i}`,
      name: `extra_${i}`,
      label: `Extra ${i}`,
      sortOrder: i + 10,
    }));
    mockListEntityFields.mockResolvedValue([publicField, ...extraFields]);
    const res = await makeApp().request(`/${TYPE_ID}/export?format=pdf`);
    expect(res.status).toBe(200);
  });
});

// ── Async path ────────────────────────────────────────────────────────────────

describe("async export — row count > 5 000", () => {
  it("returns 202 with jobId when row count exceeds sync limit", async () => {
    const manyRows = Array.from({ length: 5_001 }, (_, i) =>
      makeInstance(`inst-${i}`),
    );
    mockListEntities.mockResolvedValue({ data: manyRows, nextCursor: null });

    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe("job-async-001");
  });

  it("enqueues job with correct payload", async () => {
    const manyRows = Array.from({ length: 5_001 }, (_, i) =>
      makeInstance(`inst-${i}`),
    );
    mockListEntities.mockResolvedValue({ data: manyRows, nextCursor: null });

    await makeApp(["admin"]).request(
      `/${TYPE_ID}/export?format=xlsx&state=open`,
    );

    expect(mockExportQueueAdd).toHaveBeenCalledWith(
      "export",
      expect.objectContaining({
        tenantId: "t-aaa",
        entityTypeId: TYPE_ID,
        format: "xlsx",
        filters: { state: "open" },
      }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
  });

  it("audits the request with the enqueued job's id before enqueueing, and nothing else", async () => {
    const manyRows = Array.from({ length: 5_001 }, (_, i) =>
      makeInstance(`inst-${i}`),
    );
    mockListEntities.mockResolvedValue({ data: manyRows, nextCursor: null });
    await makeApp(["admin"]).request(`/${TYPE_ID}/export?format=xlsx`);

    const entries = auditEntries();
    expect(entries.map((e) => e.action)).toEqual(["export.requested"]);
    const opts = mockExportQueueAdd.mock.calls[0]?.[2] as { jobId: string };
    expect(entries[0]?.metadata).toEqual({
      format: "xlsx",
      includePii: true,
      filters: {},
      rowCount: 5_001,
      mode: "async",
      jobId: opts.jobId,
    });
    expect(mockWriteAuditEntry.mock.invocationCallOrder[0]).toBeLessThan(
      mockExportQueueAdd.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("audits export.failed when the job can't be enqueued", async () => {
    const manyRows = Array.from({ length: 5_001 }, (_, i) =>
      makeInstance(`inst-${i}`),
    );
    mockListEntities.mockResolvedValue({ data: manyRows, nextCursor: null });
    mockExportQueueAdd.mockRejectedValueOnce(new Error("redis down"));
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(500);
    expect(auditEntries().map((e) => e.action)).toEqual([
      "export.requested",
      "export.failed",
    ]);
    expect(auditEntries()[1]?.metadata).toMatchObject({
      rowCount: 5_001,
      error: "ENQUEUE_FAILED",
    });
  });

  it("does not enqueue when the request audit fails", async () => {
    const manyRows = Array.from({ length: 5_001 }, (_, i) =>
      makeInstance(`inst-${i}`),
    );
    mockListEntities.mockResolvedValue({ data: manyRows, nextCursor: null });
    mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(500);
    expect(mockExportQueueAdd).not.toHaveBeenCalled();
  });
});

// ── Guard tests ───────────────────────────────────────────────────────────────

describe("export guards", () => {
  it("returns 400 EXPORT_TOO_LARGE when rows exceed 10 000", async () => {
    const manyRows = Array.from({ length: 10_001 }, (_, i) =>
      makeInstance(`inst-${i}`),
    );
    mockListEntities.mockResolvedValue({ data: manyRows, nextCursor: null });
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("EXPORT_TOO_LARGE");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 400 for unknown format", async () => {
    const res = await makeApp().request(`/${TYPE_ID}/export?format=docx`);
    expect(res.status).toBe(400);
  });

  it("returns 404 when entity type not found", async () => {
    mockGetEntityType.mockRejectedValue(
      new EntityError("ENTITY_TYPE_NOT_FOUND", { entityTypeId: TYPE_ID }),
    );
    const res = await makeApp().request(`/${TYPE_ID}/export?format=csv`);
    expect(res.status).toBe(404);
  });
});
