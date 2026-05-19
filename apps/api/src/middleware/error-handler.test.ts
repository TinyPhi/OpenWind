import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { WorkflowError } from "@platform/workflow-engine";
import { EntityError, ValidationError } from "@platform/entity-engine";
import { errorHandler } from "./error-handler.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(thrownError: unknown) {
  const app = new Hono();
  app.use(errorHandler());
  app.get("/test", () => {
    throw thrownError;
  });
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("errorHandler — WorkflowError mapping", () => {
  it("returns 404 for INSTANCE_NOT_FOUND", async () => {
    const res = await makeApp(new WorkflowError("INSTANCE_NOT_FOUND")).request(
      "/test",
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("INSTANCE_NOT_FOUND");
  });

  it("returns 409 for TRANSITION_NOT_AVAILABLE", async () => {
    const res = await makeApp(
      new WorkflowError("TRANSITION_NOT_AVAILABLE"),
    ).request("/test");
    expect(res.status).toBe(409);
  });

  it("returns 403 for TRANSITION_FORBIDDEN", async () => {
    const res = await makeApp(
      new WorkflowError("TRANSITION_FORBIDDEN"),
    ).request("/test");
    expect(res.status).toBe(403);
  });

  it("returns 422 for CONDITION_NOT_MET", async () => {
    const res = await makeApp(new WorkflowError("CONDITION_NOT_MET")).request(
      "/test",
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 for REQUIRED_FIELDS_MISSING", async () => {
    const res = await makeApp(
      new WorkflowError("REQUIRED_FIELDS_MISSING"),
    ).request("/test");
    expect(res.status).toBe(422);
  });
});

describe("errorHandler — Postgres lock error (55P03)", () => {
  it("returns 409 TRANSITION_CONFLICT when lock_not_available error has code on error", async () => {
    const lockError = Object.assign(new Error("lock_not_available"), {
      code: "55P03",
    });
    const res = await makeApp(lockError).request("/test");
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TRANSITION_CONFLICT");
  });

  it("returns 409 TRANSITION_CONFLICT when lock_not_available code is on error.cause", async () => {
    const cause = { code: "55P03" };
    const lockError = Object.assign(new Error("lock_not_available"), { cause });
    const res = await makeApp(lockError).request("/test");
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("TRANSITION_CONFLICT");
  });

  it("does not treat other Postgres errors as lock conflicts", async () => {
    const otherError = Object.assign(new Error("some db error"), {
      code: "23505",
    });
    const res = await makeApp(otherError).request("/test");
    expect(res.status).toBe(500);
  });
});

describe("errorHandler — EntityError mapping", () => {
  it("returns 404 for ENTITY_NOT_FOUND", async () => {
    const res = await makeApp(new EntityError("ENTITY_NOT_FOUND")).request(
      "/test",
    );
    expect(res.status).toBe(404);
  });

  it("returns 422 for FIELD_VALIDATION_FAILED", async () => {
    const res = await makeApp(
      new EntityError("FIELD_VALIDATION_FAILED"),
    ).request("/test");
    expect(res.status).toBe(422);
  });
});

describe("errorHandler — ValidationError", () => {
  it("returns 422 with fields array", async () => {
    const res = await makeApp(
      new ValidationError([
        { field: "name", code: "too_small", message: "Required" },
      ]),
    ).request("/test");
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.fields).toHaveLength(1);
  });
});

describe("errorHandler — unhandled errors", () => {
  it("returns 500 for unknown errors without leaking details", async () => {
    const res = await makeApp(new Error("database connection refused")).request(
      "/test",
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("INTERNAL_ERROR");
    expect(json.message).not.toContain("database connection refused");
  });
});
