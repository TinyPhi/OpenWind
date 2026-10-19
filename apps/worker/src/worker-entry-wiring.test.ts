/**
 * BullMQ Workers register their processor as a side effect of `new Worker(...)` running at
 * module load, so a worker module nobody imports never processes a single job -- the queue
 * fills, and producers awaiting `waitUntilFinished` time out. PR #838 review found exactly
 * this: sandbox-reset-worker (merged in #832) and sandbox-delete-worker were never imported by
 * the worker entry point. This guard reads source text rather than importing index.ts, which
 * would start every poller and connect to Redis.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_CONSTRUCTION = /new Worker\s*[<(]/;

function workerModules(): string[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => f !== "index.ts")
    .filter((f) =>
      WORKER_CONSTRUCTION.test(readFileSync(join(SRC_DIR, f), "utf8")),
    );
}

describe("worker entry point wiring", () => {
  it("finds the BullMQ worker modules it is guarding", () => {
    const modules = workerModules();
    expect(modules.length).toBeGreaterThanOrEqual(3);
    // Pin the three sandbox workers as a floor (guarantees PR #838 review finding stays guarded)
    expect(modules).toEqual(
      expect.arrayContaining([
        "sandbox-provisioning-worker.ts",
        "sandbox-reset-worker.ts",
        "sandbox-delete-worker.ts",
      ]),
    );
    for (const mod of modules) {
      expect(mod).toMatch(/\.ts$/);
      expect(mod).not.toMatch(/\.test\.ts$/);
    }
  });

  it("imports every module that constructs a BullMQ Worker", () => {
    const index = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
    const unwired = workerModules().filter(
      (f) => !index.includes(`from "./${f.replace(/\.ts$/, ".js")}"`),
    );
    expect(
      unwired,
      "import these from apps/worker/src/index.ts (and close them in shutdown())",
    ).toEqual([]);
  });
});
