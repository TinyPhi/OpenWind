/**
 * #728 slice 1: the Superset cache flush against a real Redis. Uses two spare logical dbs of the
 * test Redis (13 stands in for Superset's db, 14 for any other db) so nothing real is touched.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { env } from "@platform/config";
import { flushSupersetCache } from "../../src/superset-cache-flush.js";

const base = new URL(env.REDIS_URL);
function client(db: number): Redis {
  const url = new URL(base.toString());
  url.pathname = `/${db}`;
  return new Redis(url.toString(), { maxRetriesPerRequest: null });
}

const superset = client(13);
const other = client(14);

async function seed(redis: Redis): Promise<void> {
  await redis.flushdb();
  await redis.set("superset_aaa", "1");
  await redis.set("superset_data_bbb", "1");
  await redis.set("celery-task-meta-1", "1");
  await redis.set("rl:tenant:1", "1");
  await redis.set("bull:export:1", "1");
}

beforeEach(async () => {
  await seed(superset);
  await seed(other);
});

afterAll(async () => {
  await superset.flushdb();
  await other.flushdb();
  superset.disconnect();
  other.disconnect();
});

describe("flushSupersetCache against real Redis", () => {
  it("removes only the two Superset prefixes in its own db", async () => {
    expect(await flushSupersetCache(superset)).toBe(2);
    expect((await superset.keys("*")).sort()).toEqual([
      "bull:export:1",
      "celery-task-meta-1",
      "rl:tenant:1",
    ]);
  });

  it("leaves another db's Superset-prefixed keys alone", async () => {
    await flushSupersetCache(superset);
    expect((await other.keys("*")).sort()).toEqual([
      "bull:export:1",
      "celery-task-meta-1",
      "rl:tenant:1",
      "superset_aaa",
      "superset_data_bbb",
    ]);
  });

  it("clears more keys than one scan page in a single call", async () => {
    const pipe = superset.pipeline();
    for (let i = 0; i < 1500; i++) pipe.set(`superset_bulk_${i}`, "1");
    await pipe.exec();
    expect(await flushSupersetCache(superset)).toBe(1502);
    expect(await superset.keys("superset_*")).toEqual([]);
  });

  it("is a no-op the second time", async () => {
    await flushSupersetCache(superset);
    expect(await flushSupersetCache(superset)).toBe(0);
  });
});
