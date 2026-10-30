import { describe, it, expect } from "vitest";
import { SUPERSET_ERASURE_JOB_OPTIONS } from "./superset-erasure-options.js";

// apps/worker/src/superset-erasure-options.test.ts pins the same object: the queue that adds a job
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
});
