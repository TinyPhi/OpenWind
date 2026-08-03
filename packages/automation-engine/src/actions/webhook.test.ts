/**
 * webhook.test.ts
 *
 * Unit tests for executeWebhookAction.
 * All network I/O is mocked — no real connections are made.
 *
 * Timing invariant:
 *   executeWebhookAction first `await`s validateWebhookUrl (a resolved-promise
 *   mock), which suspends to the next microtask tick.  After
 *   `await Promise.resolve()` that continuation has run: Agent constructed,
 *   https.request called, req.on handlers registered.  Tests capture the
 *   request handlers, then drive the response, then await the action promise.
 *
 *   NOTE: `startAction` must NOT be an `async` function that returns a Promise
 *   — async functions auto-unwrap returned Promises, so `await startAction()`
 *   would block until the whole action completes (deadlock).  Instead
 *   `startAction` is a plain async helper that resolves to a wrapper object
 *   `{ promise }` so callers hold the un-awaited action promise and can drive
 *   the fake server response themselves.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerEvent } from "../event-schemas.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type LookupCallback = (
  err: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

// ── Captured state ─────────────────────────────────────────────────────────────

let capturedLookupFn:
  | ((_h: string, opts: { all?: boolean }, cb: LookupCallback) => void)
  | undefined;
let fakeOnResponse:
  | ((res: { statusCode: number; resume: () => void }) => void)
  | undefined;
let fakeOnTimeout: (() => void) | undefined;
let fakeOnError: ((err: Error) => void) | undefined;
let fakeDestroy: ReturnType<typeof vi.fn>;

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockHttpsRequest = vi.fn();
const mockHttpRequest = vi.fn();

/** Build a fake req object wired to the module-level captured-state variables. */
function buildFakeReq() {
  fakeDestroy = vi.fn();
  const req = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "timeout") fakeOnTimeout = cb as () => void;
      if (event === "error") fakeOnError = cb as (err: Error) => void;
      return req;
    }),
    write: vi.fn(() => req),
    end: vi.fn(() => req),
    destroy: fakeDestroy,
  };
  return req;
}

vi.mock("node:https", () => ({
  default: {
    Agent: vi.fn().mockImplementation(function (opts: {
      lookup?: (
        host: string,
        opts: { all?: boolean },
        cb: LookupCallback,
      ) => void;
    }) {
      capturedLookupFn = opts.lookup;
    }),
    request: (...args: unknown[]) => mockHttpsRequest(...args),
  },
}));

vi.mock("node:http", () => ({
  default: {
    Agent: vi.fn().mockImplementation(function (opts: {
      lookup?: (
        host: string,
        opts: { all?: boolean },
        cb: LookupCallback,
      ) => void;
    }) {
      capturedLookupFn = opts.lookup;
    }),
    request: (...args: unknown[]) => mockHttpRequest(...args),
  },
}));

vi.mock("../ssrf-guard.js", () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue("1.2.3.4"),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeWebhookAction } = await import("./webhook.js");
const { validateWebhookUrl } = await import("../ssrf-guard.js");

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TRIGGER_EVENT: TriggerEvent = {
  eventType: "workflow.transitioned",
  version: 1,
  tenantId: "tenant-abc",
  instanceId: "inst-1",
  entityTypeId: "et-1",
  workflowId: "wf-1",
  fromState: "open",
  toState: "closed",
  triggeredBy: "user",
  actorId: "user-1",
  occurredAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedLookupFn = undefined;
  fakeOnResponse = undefined;
  fakeOnTimeout = undefined;
  fakeOnError = undefined;
  vi.mocked(validateWebhookUrl).mockResolvedValue("1.2.3.4");
});

// ── Helper: start action and drain microtasks ──────────────────────────────────

/**
 * Starts an executeWebhookAction call, wires the https/http mock, drains the
 * one microtask needed for validateWebhookUrl to resolve (so the Agent and
 * request are set up), and returns `{ promise }`.
 *
 * The caller MUST trigger the response (fakeOnResponse / fakeOnError /
 * fakeOnTimeout) BEFORE awaiting `promise`, otherwise the action hangs.
 *
 * Returns a plain object (not a Promise) so that `async` auto-unwrapping
 * cannot accidentally await the action prematurely.
 */
async function startAction(
  url = "https://webhook.example.com/hook",
  extra: Partial<Parameters<typeof executeWebhookAction>[3]> = {},
): Promise<{ promise: Promise<void> }> {
  const req = buildFakeReq();

  // Wire both http and https mocks — the action uses only one depending on scheme
  for (const mock of [mockHttpsRequest, mockHttpRequest]) {
    mock.mockImplementation(
      (
        _opts: unknown,
        cb: (res: { statusCode: number; resume: () => void }) => void,
      ) => {
        fakeOnResponse = cb;
        return req;
      },
    );
  }

  const promise = executeWebhookAction("tenant-abc", "rule-1", TRIGGER_EVENT, {
    url,
    ...extra,
  });

  // Drain the single microtask: validateWebhookUrl (mockResolvedValue) resolves,
  // then the Agent is constructed and https.request is called synchronously
  // inside the new Promise executor.  After this tick, all captured vars are set.
  await Promise.resolve();

  return { promise };
}

// ── lookupFn — single-address path ────────────────────────────────────────────

describe("executeWebhookAction — lookupFn (opts.all falsy)", () => {
  it("calls callback with (null, string, 4) for an IPv4 validated IP", async () => {
    const { promise } = await startAction();

    expect(capturedLookupFn).toBeDefined();
    const cb = vi.fn();
    capturedLookupFn!("webhook.example.com", { all: false }, cb);
    expect(cb).toHaveBeenCalledWith(null, "1.2.3.4", 4);

    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;
  });

  it("calls callback with family=6 for an IPv6 validated IP", async () => {
    vi.mocked(validateWebhookUrl).mockResolvedValue("2001:db8::1");
    const { promise } = await startAction();

    const cb = vi.fn();
    capturedLookupFn!("webhook.example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "2001:db8::1", 6);

    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;
  });
});

// ── lookupFn — opts.all = true (the bug that was fixed) ───────────────────────

describe("executeWebhookAction — lookupFn (opts.all = true)", () => {
  it("returns Array<{address,family}> — does NOT call back with bare string (would throw ERR_INVALID_IP_ADDRESS)", async () => {
    const { promise } = await startAction();

    expect(capturedLookupFn).toBeDefined();

    const cb = vi.fn();
    capturedLookupFn!("webhook.example.com", { all: true }, cb);

    // Must receive array form
    expect(cb).toHaveBeenCalledWith(null, [{ address: "1.2.3.4", family: 4 }]);
    // Must NOT receive bare string form (that would crash Node with ERR_INVALID_IP_ADDRESS)
    expect(cb).not.toHaveBeenCalledWith(
      null,
      expect.any(String),
      expect.any(Number),
    );

    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;
  });

  it("includes family=6 in the array for an IPv6 validated IP", async () => {
    vi.mocked(validateWebhookUrl).mockResolvedValue("2001:db8::1");
    const { promise } = await startAction();

    const cb = vi.fn();
    capturedLookupFn!("webhook.example.com", { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [
      { address: "2001:db8::1", family: 6 },
    ]);

    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;
  });
});

// ── SSRF guard ────────────────────────────────────────────────────────────────

describe("executeWebhookAction — SSRF guard", () => {
  it("re-throws WEBHOOK_SSRF_BLOCKED and makes no network request", async () => {
    const { AutomationError } = await import("../types.js");
    vi.mocked(validateWebhookUrl).mockRejectedValue(
      new AutomationError("WEBHOOK_SSRF_BLOCKED", {
        url: "https://internal/hook",
        reason: "rfc1918",
      }),
    );

    await expect(
      executeWebhookAction("tenant-abc", "rule-1", TRIGGER_EVENT, {
        url: "https://internal/hook",
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_SSRF_BLOCKED" });

    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });
});

// ── HTTP response handling ────────────────────────────────────────────────────

describe("executeWebhookAction — HTTP responses", () => {
  it("resolves on 200", async () => {
    const { promise } = await startAction();
    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await expect(promise).resolves.toBeUndefined();
  });

  it("resolves on 201", async () => {
    const { promise } = await startAction();
    fakeOnResponse!({ statusCode: 201, resume: vi.fn() });
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with ACTION_FAILED on 500", async () => {
    const { promise } = await startAction();
    fakeOnResponse!({ statusCode: 500, resume: vi.fn() });
    await expect(promise).rejects.toMatchObject({ code: "ACTION_FAILED" });
  });

  it("rejects with ACTION_FAILED on network error", async () => {
    const { promise } = await startAction();
    fakeOnError!(new Error("ECONNRESET"));
    await expect(promise).rejects.toMatchObject({
      code: "ACTION_FAILED",
      meta: expect.objectContaining({ reason: "network-error" }),
    });
  });

  it("rejects with ACTION_FAILED on timeout and calls req.destroy()", async () => {
    const { promise } = await startAction("https://webhook.example.com/hook", {
      timeoutMs: 100,
    });
    fakeOnTimeout!();
    await expect(promise).rejects.toMatchObject({
      code: "ACTION_FAILED",
      meta: expect.objectContaining({ reason: "timeout" }),
    });
    expect(fakeDestroy).toHaveBeenCalled();
  });
});

// ── Protocol dispatch ─────────────────────────────────────────────────────────

describe("executeWebhookAction — protocol dispatch", () => {
  it("uses https.request for https:// URLs", async () => {
    const { promise } = await startAction("https://webhook.example.com/hook");
    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;
    expect(mockHttpsRequest).toHaveBeenCalled();
    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it("uses http.request for http:// URLs", async () => {
    const { promise } = await startAction("http://webhook.example.com/hook");
    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;
    expect(mockHttpRequest).toHaveBeenCalled();
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});

describe("executeWebhookAction — payload customization & filtering", () => {
  it("defaults to includePayload: false (sends empty object)", async () => {
    const { promise } = await startAction("https://webhook.example.com/hook");
    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;

    const mockReq = vi.mocked(mockHttpsRequest).mock.results[0]?.value;
    expect(mockReq.write).toHaveBeenCalledWith("{}");
  });

  it("sends full payload when includePayload: true", async () => {
    const { promise } = await startAction("https://webhook.example.com/hook", {
      includePayload: true,
    });
    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;

    const mockReq = vi.mocked(mockHttpsRequest).mock.results[0]?.value;
    expect(mockReq.write).toHaveBeenCalledWith(JSON.stringify(TRIGGER_EVENT));
  });

  it("filters entity.created fields using sendFields allowlist", async () => {
    const entityCreatedEvent: TriggerEvent = {
      eventType: "entity.created",
      version: 1,
      tenantId: "tenant-abc",
      instanceId: "inst-1",
      entityTypeId: "et-1",
      fields: {
        pii_ssn: "123-45-678",
        public_name: "OpenWind",
      },
      createdBy: null,
    };

    const req = buildFakeReq();
    mockHttpsRequest.mockImplementation(
      (
        _opts: unknown,
        cb: (res: { statusCode: number; resume: () => void }) => void,
      ) => {
        fakeOnResponse = cb;
        return req;
      },
    );

    const promise = executeWebhookAction(
      "tenant-abc",
      "rule-1",
      entityCreatedEvent,
      {
        url: "https://webhook.example.com/hook",
        includePayload: true,
        sendFields: ["public_name"],
      },
    );
    await Promise.resolve();

    fakeOnResponse!({ statusCode: 200, resume: vi.fn() });
    await promise;

    expect(req.write).toHaveBeenCalledWith(
      JSON.stringify({
        ...entityCreatedEvent,
        fields: { public_name: "OpenWind" },
      }),
    );
  });
});
