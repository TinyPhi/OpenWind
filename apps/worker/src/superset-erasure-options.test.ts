import { describe, it, expect } from "vitest";
import {
  SUPERSET_ERASURE_ATTEMPTS,
  SUPERSET_ERASURE_JOB_OPTIONS,
  supersetErasureBackoff,
} from "./superset-erasure-options.js";

// apps/api/src/lib/superset-erasure-options.test.ts pins the same object: the queue that adds a job
// sets its options, so the two files must not drift apart.
describe("superset-erasure job options (#728)", () => {
  it("are 32 attempts on the custom backoff, keeping a finished job for 1 hour and a failed one for 7 days", () => {
    expect(SUPERSET_ERASURE_JOB_OPTIONS).toEqual({
      attempts: 32,
      backoff: { type: "custom" },
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 604_800 },
    });
  });

  it("use the attempts constant the backoff schedule is checked against", () => {
    expect(SUPERSET_ERASURE_JOB_OPTIONS.attempts).toBe(
      SUPERSET_ERASURE_ATTEMPTS,
    );
  });

  it("wait 1, 2, 4, 8, 16, 32 minutes, then 1 hour, about 26 hours in all", () => {
    const waits = Array.from(
      { length: SUPERSET_ERASURE_ATTEMPTS - 1 },
      (_, i) => supersetErasureBackoff(i + 1),
    );
    expect(waits.slice(0, 7).map((ms) => ms / 60_000)).toEqual([
      1, 2, 4, 8, 16, 32, 60,
    ]);
    expect(waits.every((ms) => ms <= 3_600_000)).toBe(true);
    const hours = waits.reduce((a, b) => a + b, 0) / 3_600_000;
    expect(hours).toBeGreaterThanOrEqual(24);
    expect(hours).toBeLessThan(27);
  });
});
