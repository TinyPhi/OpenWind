/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@platform/logger", () => ({
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
