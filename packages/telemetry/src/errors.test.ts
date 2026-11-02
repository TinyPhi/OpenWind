/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as LoggerModule from "@platform/logger";

// Mutable mock config
const mockEnv = {
  ERROR_TRACKING_PROVIDER: "none",
  SENTRY_DSN: undefined as string | undefined,
  NODE_ENV: "test",
};

vi.mock("@platform/config", () => ({
  env: mockEnv,
}));

// Mock logger
const mockWarn = vi.fn();
const mockInfo = vi.fn();
const mockError = vi.fn();
vi.mock("@platform/logger", async (importOriginal) => ({
  ...(await importOriginal<typeof LoggerModule>()),
  logger: {
    warn: mockWarn,
    info: mockInfo,
    error: mockError,
  },
}));

// Mock Sentry SDK
const mockSentryInit = vi.fn();
const mockSentryCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  init: mockSentryInit,
  captureException: mockSentryCaptureException,
}));

let startErrorTracking: any;
let scrubPIIInPlace: any;
let captureException: any;

describe("Error Tracking Initialization", () => {
  beforeEach(async () => {
    vi.resetModules();
    const errorsModule = await import("./errors.js");
    startErrorTracking = errorsModule.startErrorTracking;
    scrubPIIInPlace = errorsModule.scrubPIIInPlace;
    captureException = errorsModule.captureException;

    mockSentryInit.mockClear();
    mockSentryCaptureException.mockClear();
    mockWarn.mockClear();
    mockInfo.mockClear();
    mockError.mockClear();
  });

  it("does not initialize error tracking when provider is 'none'", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "none";
    mockEnv.SENTRY_DSN = undefined;

    startErrorTracking();

    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("logs warning and skips when DSN is missing for a provider", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = undefined;

    startErrorTracking();

    expect(mockSentryInit).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("SENTRY_DSN is missing"),
    );
  });

  it("initializes Sentry when provider and DSN are set", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = "https://public@sentry.io/1";

    startErrorTracking();

    expect(mockSentryInit).toHaveBeenCalledTimes(1);
    expect(mockSentryInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://public@sentry.io/1",
        environment: "test",
        beforeSend: expect.any(Function),
      }),
    );
  });

  it("pins the privacy posture: PII off and no Sentry tracing/profiling options", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = "https://public@sentry.io/1";

    startErrorTracking();

    // vi.fn() call args are untyped; first init argument is the options object
    const options = (mockSentryInit.mock.calls[0] ?? [])[0] as Record<
      string,
      unknown
    >;
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("tracesSampler");
    expect(options).not.toHaveProperty("profilesSampleRate");
    expect(options).not.toHaveProperty("integrations");
  });

  it("drops the event by returning null when scrubbing throws", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = "https://public@sentry.io/1";
    startErrorTracking();

    const beforeSendFn = mockSentryInit.mock.calls[0]?.[0]?.beforeSend;
    if (!beforeSendFn) {
      throw new Error("beforeSendFn is not defined");
    }
    const offendingEvent = {};
    Object.defineProperty(offendingEvent, "password", {
      enumerable: true,
      get() {
        throw new Error("scrub failure");
      },
    });

    const result = beforeSendFn(offendingEvent);
    expect(result).toBeNull();
    expect(mockError).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining("dropping event to prevent data leak"),
    );
  });
});

describe("Manual Exception Capture", () => {
  beforeEach(async () => {
    vi.resetModules();
    const errorsModule = await import("./errors.js");
    startErrorTracking = errorsModule.startErrorTracking;
    captureException = errorsModule.captureException;

    mockSentryInit.mockClear();
    mockSentryCaptureException.mockClear();
  });

  it("does not report error when provider is 'none'", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "none";
    captureException(new Error("test error"));
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });

  it("reports error when provider is active and initialized successfully", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = "https://public@sentry.io/1";
    startErrorTracking();
    captureException(new Error("test error"));
    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("does not report error when provider is active but init failed", () => {
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = "https://public@sentry.io/1";
    mockSentryInit.mockImplementationOnce(() => {
      throw new Error("init failed");
    });
    startErrorTracking();
    captureException(new Error("test error"));
    expect(mockSentryCaptureException).not.toHaveBeenCalled();
  });
});

describe("PII Scrubbing", () => {
  beforeEach(async () => {
    const errorsModule = await import("./errors.js");
    scrubPIIInPlace = errorsModule.scrubPIIInPlace;
  });

  it("redacts sensitive keys in-place and leaves others untouched", () => {
    const payload = {
      user: {
        id: "123",
        email: "user@example.com",
        password: "mySuperSecretPassword",
      },
      request: {
        url: "/api/login",
        headers: {
          authorization: "Bearer my-secret-token",
          cookie: "session=12345",
          "content-type": "application/json",
        },
      },
      extra: {
        secret: "confidential",
        token: "oauth-tok",
        safeValue: "ok",
      },
    };

    scrubPIIInPlace(payload);

    expect(payload.user.password).toBe("[REDACTED]");
    expect(payload.request.headers.authorization).toBe("[REDACTED]");
    expect(payload.request.headers.cookie).toBe("[REDACTED]");
    expect(payload.extra.secret).toBe("[REDACTED]");
    expect(payload.extra.token).toBe("[REDACTED]");
    expect(payload.user.email).toBe("[REDACTED]");

    expect(payload.user.id).toBe("123");
    expect(payload.request.url).toBe("/api/login");
    expect(payload.request.headers["content-type"]).toBe("application/json");
    expect(payload.extra.safeValue).toBe("ok");
  });

  it("handles circular references gracefully without throwing or loops", () => {
    const payload: any = {
      name: "test",
      safe: "yes",
      password: "secretpassword",
    };
    payload.self = payload; // circular reference

    expect(() => scrubPIIInPlace(payload)).not.toThrow();
    expect(payload.password).toBe("[REDACTED]");
    expect(payload.name).toBe("test");
    expect(payload.self).toBe(payload);
  });

  it("recursively scrubs nested arrays", () => {
    const payload: any = {
      items: [
        { name: "normal", token: "tok1" },
        { name: "normal2", cookie: "cook1" },
      ],
    };

    scrubPIIInPlace(payload);

    expect(payload.items[0].token).toBe("[REDACTED]");
    expect(payload.items[1].cookie).toBe("[REDACTED]");
    expect(payload.items[0].name).toBe("normal");
    expect(payload.items[1].name).toBe("normal2");
  });
});

const SMOKE_MESSAGE =
  "user bob@example.com token Bearer abc.def.ghi password=hunter2";

describe("Sentry event scrubbing (ADR-015 Decision #2)", () => {
  async function beforeSend(): Promise<(e: any) => any> {
    vi.resetModules();
    const { startErrorTracking: start } = await import("./errors.js");
    mockEnv.ERROR_TRACKING_PROVIDER = "sentry";
    mockEnv.SENTRY_DSN = "https://public@sentry.io/1";
    mockSentryInit.mockClear();
    start();
    return mockSentryInit.mock.calls[0]?.[0]?.beforeSend;
  }

  const planted = [
    "bob@example.com",
    "abc.def.ghi",
    "hunter2",
    "dave@example.com",
    "203.0.113.7",
  ];

  it("scrubs message, exception, breadcrumbs, extra, contexts and tags", async () => {
    const hook = await beforeSend();
    const event = hook({
      message: SMOKE_MESSAGE,
      exception: { values: [{ type: "Error", value: SMOKE_MESSAGE }] },
      breadcrumbs: [
        { message: "contact dave@example.com", data: { note: SMOKE_MESSAGE } },
      ],
      extra: { note: "contact dave@example.com", password: "x" },
      contexts: { app: { detail: SMOKE_MESSAGE } },
      tags: { who: "dave@example.com" },
      user: { id: "u1", ip_address: "203.0.113.7" },
      server_name: "abhinavs-macbook.local",
    });
    const out = JSON.stringify(event);
    for (const s of planted) expect(out).not.toContain(s);
    expect(event.message).toBe(
      "user [REDACTED] token Bearer [REDACTED] password=[REDACTED]",
    );
    expect(event.extra.password).toBe("[REDACTED]");
    expect(event.user).toEqual({ id: "u1" });
    expect(event).not.toHaveProperty("server_name");
  });

  it("drops request body and query string and strips the URL query", async () => {
    const hook = await beforeSend();
    const event = hook({
      request: {
        url: "https://x.test/a/b?user=alice&ssn=1#frag",
        query_string: "user=alice",
        data: { name: "Alice" },
        method: "POST",
      },
    });
    expect(event.request).toEqual({
      url: "https://x.test/a/b",
      method: "POST",
    });
  });

  it("drops stack-frame source context lines but keeps frame location", async () => {
    const hook = await beforeSend();
    const event = hook({
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: "a.ts",
                  pre_context: ["const a = 1;"],
                  context_line: 'const password = "hunter2";',
                  post_context: ["login(bob@example.com);"],
                },
              ],
            },
          },
        ],
      },
    });
    const out = JSON.stringify(event);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("bob@example.com");
    expect(out).not.toContain("const a = 1;");
    expect(event.exception.values[0].stacktrace.frames[0]).toEqual({
      filename: "a.ts",
    });
  });
});
