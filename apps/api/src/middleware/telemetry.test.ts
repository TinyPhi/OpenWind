import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock @platform/telemetry
const mockAdd = vi.fn();
const mockRecord = vi.fn();

vi.mock("@platform/telemetry", () => ({
  httpRequestsTotal: { add: mockAdd },
  httpRequestDuration: { record: mockRecord },
}));

const { telemetry } = await import("./telemetry.js");

function makeApp() {
  const app = new Hono();
  // Mock auth context getter
  app.use("*", async (c, next) => {
    c.set("auth", { tenantId: "tenant-123" });
    await next();
  });
  app.use("*", telemetry());
  app.get("/test", (c) => c.text("success"));
  app.get("/metrics", (c) => c.text("metrics"));
  return app;
}

describe("telemetry middleware", () => {
  beforeEach(() => {
    mockAdd.mockClear();
    mockRecord.mockClear();
  });

  it("records request count and duration metrics", async () => {
    const app = makeApp();
    const res = await app.request("/test", { method: "GET" });

    expect(res.status).toBe(200);
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd).toHaveBeenCalledWith(1, {
      method: "GET",
      route: "/test",
      status: "200",
      tenant_id: "tenant-123",
    });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(expect.any(Number), {
      method: "GET",
      route: "/test",
      status: "200",
      tenant_id: "tenant-123",
    });
  });

  it("skips /metrics endpoint", async () => {
    const app = makeApp();
    const res = await app.request("/metrics", { method: "GET" });

    expect(res.status).toBe(200);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
