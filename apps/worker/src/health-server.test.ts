import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockQueuesConnection = { status: "ready" as string };
const mockAutomationConnection = { status: "ready" as string };

vi.mock("./queues.js", () => ({
  connection: mockQueuesConnection,
}));

vi.mock("./automation-worker.js", () => ({
  connection: mockAutomationConnection,
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// A minimal EventEmitter-like fake server: supports the one .on("error", ...)
// listener health-server.ts registers, and a controllable .close() so both
// the happy path and the "close reports an error" path can be exercised.
function makeFakeServer() {
  let errorHandler: ((err: Error) => void) | undefined;
  let closeError: Error | undefined;
  return {
    on: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === "error") errorHandler = handler;
    }),
    close: vi.fn((cb: (err?: Error) => void) => cb(closeError)),
    // Test helpers, not part of the real http.Server API:
    __triggerError(err: Error) {
      errorHandler?.(err);
    },
    __setCloseError(err: Error) {
      closeError = err;
    },
  };
}

let fakeServer: ReturnType<typeof makeFakeServer>;
const mockServe = vi.fn(() => fakeServer);

vi.mock("@hono/node-server", () => ({
  serve: (...args: unknown[]) => mockServe(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

const { app, startHealthServer, stopHealthServer } =
  await import("./health-server.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /healthz", () => {
  beforeEach(() => {
    mockQueuesConnection.status = "ready";
    mockAutomationConnection.status = "ready";
  });

  it("returns 200 {status: ok} when both Redis connections are ready", async () => {
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });

  it("returns 503 when the shared queues connection is not ready", async () => {
    mockQueuesConnection.status = "connecting";

    const res = await app.request("/healthz");

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toEqual({
      status: "error",
      redis: { queues: "connecting", automation: "ready" },
    });
  });

  it("returns 503 when the automation-worker connection is not ready — the gap a queues-only check would miss", async () => {
    mockAutomationConnection.status = "reconnecting";

    const res = await app.request("/healthz");

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toEqual({
      status: "error",
      redis: { queues: "ready", automation: "reconnecting" },
    });
  });
});

describe("startHealthServer / stopHealthServer", () => {
  beforeEach(() => {
    fakeServer = makeFakeServer();
    mockServe.mockClear();
  });

  it("stopHealthServer is a no-op when the server was never started", async () => {
    await expect(stopHealthServer()).resolves.toBeUndefined();
  });

  it("starts and stops the server without throwing", async () => {
    startHealthServer();
    await expect(stopHealthServer()).resolves.toBeUndefined();
  });

  it("a bind error logs and does not throw or crash the process", async () => {
    startHealthServer();

    expect(() =>
      fakeServer.__triggerError(new Error("EADDRINUSE")),
    ).not.toThrow();

    const { logger } = await import("@platform/logger");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3002 }),
      expect.stringContaining("failed to start"),
    );

    // A subsequent stop is still a safe no-op after a failed bind.
    await expect(stopHealthServer()).resolves.toBeUndefined();
  });

  it("resolves (does not reject) when server.close reports an error", async () => {
    fakeServer.__setCloseError(new Error("server was not open"));
    startHealthServer();

    await expect(stopHealthServer()).resolves.toBeUndefined();

    const { logger } = await import("@platform/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("close reported an error"),
    );
  });
});
