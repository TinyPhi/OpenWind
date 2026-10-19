import { describe, it, expect } from "vitest";
import { classifyJobAfterWaitError } from "./job-wait.js";

const jobIn = (state: string) => ({ getState: () => Promise.resolve(state) });

describe("classifyJobAfterWaitError", () => {
  it.each(["active", "waiting", "delayed", "prioritized", "waiting-children"])(
    "treats a %s job as still running: only the wait gave up",
    async (state) => {
      expect(await classifyJobAfterWaitError(jobIn(state))).toBe(
        "still-running",
      );
    },
  );

  it("treats a failed job as failed, whatever its failure message says", async () => {
    expect(await classifyJobAfterWaitError(jobIn("failed"))).toBe("failed");
  });

  it("recognises a job that finished in the gap before the state was read", async () => {
    expect(await classifyJobAfterWaitError(jobIn("completed"))).toBe(
      "completed",
    );
  });

  it("returns unknown for an unrecognised state", async () => {
    expect(await classifyJobAfterWaitError(jobIn("unknown"))).toBe("unknown");
  });

  it("returns unknown when the state cannot be read (for example Redis is down)", async () => {
    const job = { getState: () => Promise.reject(new Error("redis down")) };
    expect(await classifyJobAfterWaitError(job)).toBe("unknown");
  });
});
