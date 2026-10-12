import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SCHEDULE_DURATION_BUCKETS_MS } from "./schedule-duration-buckets.js";

const here = dirname(fileURLToPath(import.meta.url));
// Comments are stripped so a commented-out registration cannot count as exposed.
const metricsSource = readFileSync(resolve(here, "metrics.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");
const rulesSource = readFileSync(
  resolve(here, "../../../docker/observability/alert.rules.yml"),
  "utf8",
);

/** The series names Prometheus will actually expose for what metrics.ts registers. */
function exposedSeriesNames(): Set<string> {
  const names = new Set<string>();
  const re =
    /create(Counter|UpDownCounter|Histogram|ObservableGauge|ObservableCounter|ObservableUpDownCounter|Gauge)\(\s*"([^"]+)"/g;
  for (const [, kind, name] of metricsSource.matchAll(re)) {
    if (kind === "Histogram") {
      for (const suffix of ["_bucket", "_sum", "_count"]) {
        names.add(`${name}${suffix}`);
      }
    } else if (kind === "Counter" || kind === "UpDownCounter") {
      // The exporter appends _total to a counter that lacks it.
      names.add(name?.endsWith("_total") ? name : `${name}_total`);
    } else {
      names.add(name ?? "");
    }
  }
  return names;
}

/** Every platform metric a rule's expression reads, ignoring comments and annotations. */
function metricsReferencedByRules(): Set<string> {
  const referenced = new Set<string>();
  // Prefixes come from what is registered, so a rule on any registered family
  // (openwind_, http_, bullmq_, billing_, ...) is checked, not just three.
  const prefixes = new Set(
    [...exposedSeriesNames()].map((name) => name.split("_")[0] ?? ""),
  );
  const tokenRe = new RegExp(
    `\\b(?:${[...prefixes].join("|")})_[a-z0-9_]+`,
    "g",
  );
  const lines = rulesSource.split("\n");
  let inExpr = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    const key = /^\s*(?:- )?([a-z_]+):/.exec(line)?.[1];
    if (key) inExpr = key === "expr";
    if (!inExpr) continue;
    for (const [token] of line.matchAll(tokenRe)) {
      referenced.add(token);
    }
  }
  return referenced;
}

describe("alert.rules.yml", () => {
  it("only reads metrics that metrics.ts registers, so a rule cannot point at a series that does not exist", () => {
    const exposed = exposedSeriesNames();
    const referenced = metricsReferencedByRules();

    expect(referenced.size).toBeGreaterThan(0);
    const missing = [...referenced].filter((name) => !exposed.has(name));
    expect(missing).toEqual([]);
  });

  it("reads the scheduler duration histograms through their _bucket series", () => {
    const referenced = metricsReferencedByRules();

    expect(referenced).toContain("openwind_schedule_tick_duration_ms_bucket");
    expect(referenced).toContain(
      "openwind_schedule_execution_duration_ms_bucket",
    );
  });
});

describe("scheduler duration buckets", () => {
  it("are applied to both scheduler duration histograms in metrics.ts", () => {
    const applied = metricsSource.match(
      /explicitBucketBoundaries:\s*SCHEDULE_DURATION_BUCKETS_MS/g,
    );

    expect(applied).toHaveLength(2);
  });

  it("keep a finite bucket above the largest alert threshold, so a p99 over the SLO is observable", () => {
    // histogram_quantile returns the top finite bucket at most, so with a top
    // bucket of 10000 the 10000 ms execution rule could never fire.
    const largestThresholdMs = 10_000;

    expect(Math.max(...SCHEDULE_DURATION_BUCKETS_MS)).toBeGreaterThan(
      largestThresholdMs,
    );
  });

  it("include the SLO thresholds themselves as boundaries", () => {
    expect(SCHEDULE_DURATION_BUCKETS_MS).toContain(5000);
    expect(SCHEDULE_DURATION_BUCKETS_MS).toContain(10000);
  });

  it("are strictly ascending", () => {
    const sorted = [...SCHEDULE_DURATION_BUCKETS_MS].sort((a, b) => a - b);
    expect(SCHEDULE_DURATION_BUCKETS_MS).toEqual(sorted);
    expect(new Set(sorted).size).toBe(sorted.length);
  });
});
