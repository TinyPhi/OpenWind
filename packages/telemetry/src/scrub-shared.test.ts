import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/config", () => ({
  env: { ERROR_TRACKING_PROVIDER: "none", NODE_ENV: "test" },
}));
import * as logger from "@platform/logger";
import * as telemetry from "./errors.js";

describe("single source of scrubbing rules", () => {
  it("telemetry re-uses the logger package's scrubber, not its own copy", () => {
    expect(telemetry.scrubPIIInPlace).toBe(logger.scrubPIIInPlace);
  });

  it("the Sentry scrubber applies the logger's patterns and keys", () => {
    const event = {
      message: "x " + "a@b.co",
      extra: Object.fromEntries(logger.REDACT_KEYS.map((k) => [k, "leak"])),
    };
    telemetry.scrubSentryEvent(event);
    expect(event.message).toBe("x " + logger.REDACTED);
    expect(Object.values(event.extra).every((v) => v === logger.REDACTED)).toBe(
      true,
    );
  });
});
