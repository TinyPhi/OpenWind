import { describe, it, expect, vi } from "vitest";

const capturedOpts: unknown[] = [];

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function (_name: string, opts: unknown) {
    capturedOpts.push(opts);
  }),
}));

vi.mock("./redis.js", () => ({ connection: {} }));

describe("mentionResolutionQueue", () => {
  it("sets a retry policy — PR #470 review finding 2: without this BullMQ defaults to attempts: 1", async () => {
    await import("./mention-resolution-queue.js");

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]).toMatchObject({
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
      },
    });
  });
});
