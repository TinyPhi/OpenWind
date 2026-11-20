/**
 * ADR-019 Stage 2 criterion 15 (#1140, review M1) -- a failed erasure job's payload
 * `{kind, tenantId, subject}` must not stay in Redis past its documented retention.
 *
 * BullMQ applies `removeOnFail.age` lazily: it trims old failed jobs only when another job in the
 * same queue moves to `failed`. So a failure that is never followed by another one keeps its
 * payload. `cleanSupersetErasureFailedJobs` removes old failed jobs on a schedule instead.
 *
 * Real Redis and real BullMQ, on a throwaway queue name; no mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "@platform/config";
import {
  cleanSupersetErasureFailedJobs,
  cleanSupersetErasureFinishedJobs,
} from "../../src/superset-erasure-failed-cleanup.js";
import {
  SUPERSET_ERASURE_COMPLETED_RETENTION_SECONDS,
  SUPERSET_ERASURE_FAILED_RETENTION_SECONDS,
} from "../../src/superset-erasure-options.js";

const QUEUE = `superset-erasure-cleanup-test-${Date.now()}`;
const RETENTION_MS = SUPERSET_ERASURE_FAILED_RETENTION_SECONDS * 1_000;
const COMPLETED_RETENTION_MS =
  SUPERSET_ERASURE_COMPLETED_RETENTION_SECONDS * 1_000;
const SUBJECT = "zitadel-subject-to-be-erased";

let connection: Redis;
let queue: Queue;
let worker: Worker;

const jobKey = (id: string): string => `bull:${QUEUE}:${id}`;

async function addFailingJob(
  jobId: string,
  opts: { removeOnFail?: { age: number } } = {},
): Promise<void> {
  await queue.add(
    "erase",
    { kind: "user", tenantId: "t-1", subject: SUBJECT },
    { jobId, attempts: 1, ...opts },
  );
  for (let i = 0; i < 100; i++) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === "failed") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} did not fail`);
}

/** Pretend the job failed `agoMs` ago: its finishedOn and its score in the failed set. */
async function ageFailure(jobId: string, agoMs: number): Promise<void> {
  const failedAt = Date.now() - agoMs;
  await connection.hset(jobKey(jobId), "finishedOn", String(failedAt));
  await connection.zadd(`bull:${QUEUE}:failed`, failedAt, jobId);
}

async function addCompletedJob(
  jobId: string,
  opts: { removeOnComplete?: { age: number } } = {},
): Promise<void> {
  await queue.add(
    "erase-ok",
    { kind: "user", tenantId: "t-1", subject: SUBJECT },
    { jobId, attempts: 1, ...opts },
  );
  for (let i = 0; i < 100; i++) {
    const job = await queue.getJob(jobId);
    if (job && (await job.getState()) === "completed") return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${jobId} did not complete`);
}

async function ageCompletion(jobId: string, agoMs: number): Promise<void> {
  const doneAt = Date.now() - agoMs;
  await connection.hset(jobKey(jobId), "finishedOn", String(doneAt));
  await connection.zadd(`bull:${QUEUE}:completed`, doneAt, jobId);
}

beforeAll(async () => {
  connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(QUEUE, { connection });
  worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === "erase-ok") return;
      throw new Error("Superset is unreachable");
    },
    { connection },
  );
  await worker.waitUntilReady();
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

describe("failed superset-erasure jobs are removed on a schedule (#1140 M1)", () => {
  it("premise: BullMQ's removeOnFail.age does not remove an old failed job when nothing else fails", async () => {
    await addFailingJob("lazy-1", { removeOnFail: { age: 1 } });
    await ageFailure("lazy-1", RETENTION_MS + 60_000);
    await new Promise((r) => setTimeout(r, 1_500));

    expect(await connection.exists(jobKey("lazy-1"))).toBe(1);
    const job = await queue.getJob("lazy-1");
    expect(job?.data).toMatchObject({ subject: SUBJECT });

    await queue.remove("lazy-1");
  });

  it("removes a job that failed more than the retention ago, with no later failure, payload included", async () => {
    await addFailingJob("old-1");
    await ageFailure("old-1", RETENTION_MS + 60_000);
    expect(await connection.exists(jobKey("old-1"))).toBe(1);

    const removed = await cleanSupersetErasureFailedJobs(queue);

    expect(removed).toBe(1);
    expect(await queue.getJob("old-1")).toBeUndefined();
    expect(await connection.exists(jobKey("old-1"))).toBe(0);
  });

  it("keeps a job that failed inside the retention, and removes it once it is older", async () => {
    await addFailingJob("recent-1");
    await ageFailure("recent-1", RETENTION_MS - 60 * 60_000);

    expect(await cleanSupersetErasureFailedJobs(queue)).toBe(0);
    expect(await queue.getJob("recent-1")).toBeDefined();

    await ageFailure("recent-1", RETENTION_MS + 60_000);
    expect(await cleanSupersetErasureFailedJobs(queue)).toBe(1);
    expect(await queue.getJob("recent-1")).toBeUndefined();
  });

  it("ages a job by when it failed, not by when it was created", async () => {
    await addFailingJob("long-retry-1");
    // Created long ago (it retried for ~26 hours), but it failed just now.
    await connection.hset(
      jobKey("long-retry-1"),
      "timestamp",
      String(Date.now() - RETENTION_MS * 2),
    );

    expect(await cleanSupersetErasureFailedJobs(queue)).toBe(0);
    expect(await queue.getJob("long-retry-1")).toBeDefined();
  });

  it("removes a completed job past its retention too, since its payload names the person as well", async () => {
    await addCompletedJob("done-lazy-1", { removeOnComplete: { age: 1 } });
    await ageCompletion("done-lazy-1", COMPLETED_RETENTION_MS + 60_000);
    await new Promise((r) => setTimeout(r, 1_500));
    // Premise: BullMQ's own removal is lazy for completed jobs as well.
    expect(await connection.exists(jobKey("done-lazy-1"))).toBe(1);

    const removed = await cleanSupersetErasureFinishedJobs(queue);

    expect(removed.completed).toBeGreaterThanOrEqual(1);
    expect(await queue.getJob("done-lazy-1")).toBeUndefined();
    expect(await connection.exists(jobKey("done-lazy-1"))).toBe(0);
  });

  it("keeps a completed job inside its retention", async () => {
    await addCompletedJob("done-recent-1");
    await ageCompletion("done-recent-1", COMPLETED_RETENTION_MS - 5 * 60_000);

    await cleanSupersetErasureFinishedJobs(queue);

    expect(await queue.getJob("done-recent-1")).toBeDefined();
  });
});
