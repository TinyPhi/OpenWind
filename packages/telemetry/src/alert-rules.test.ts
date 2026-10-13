import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SCHEDULE_DURATION_BUCKETS_MS } from "./schedule-duration-buckets.js";
import {
  NOTIFICATION_DISPATCH_BUCKETS_SECONDS,
  ONCALL_RESOLUTION_BUCKETS_SECONDS,
} from "./oncall-duration-buckets.js";

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

/** Numeric `> N` thresholds of every rule expression that reads `series`. */
function alertThresholds(series: string): number[] {
  const thresholds: number[] = [];
  for (const line of rulesSource.split("\n")) {
    if (!line.includes(series)) continue;
    const match = /\)\s*>\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (match?.[1]) thresholds.push(Number(match[1]));
  }
  return thresholds;
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

  // The thresholds are read from the rules themselves, so a new or changed
  // alert cannot outrun the buckets without this failing.
  function scheduleDurationThresholdsMs(): number[] {
    return [
      ...alertThresholds("openwind_schedule_tick_duration_ms_bucket"),
      ...alertThresholds("openwind_schedule_execution_duration_ms_bucket"),
    ];
  }

  it("keep a finite bucket above the largest alert threshold, so a p99 over the SLO is observable", () => {
    // histogram_quantile returns the top finite bucket at most, so a threshold
    // at or above the top bucket could never fire.
    const thresholds = scheduleDurationThresholdsMs();

    expect(thresholds).toHaveLength(2);
    expect(Math.max(...SCHEDULE_DURATION_BUCKETS_MS)).toBeGreaterThan(
      Math.max(...thresholds),
    );
  });

  it("include every SLO threshold in the rules as a boundary", () => {
    for (const threshold of scheduleDurationThresholdsMs()) {
      expect(SCHEDULE_DURATION_BUCKETS_MS).toContain(threshold);
    }
  });

  it("are strictly ascending", () => {
    const sorted = [...SCHEDULE_DURATION_BUCKETS_MS].sort((a, b) => a - b);
    expect(SCHEDULE_DURATION_BUCKETS_MS).toEqual(sorted);
    expect(new Set(sorted).size).toBe(sorted.length);
  });
});

describe("on-call duration buckets (seconds)", () => {
  // `sloSeconds` is the design's SLO (docs/oncall-routing-design.md section 9.3).
  // Any alert that reads the histogram adds its own threshold, read from the
  // rules, so a new or changed alert cannot outrun the buckets. Only the
  // resolution histogram has an alert today; none reads the dispatch one yet.
  const cases = [
    {
      name: "resolution",
      constant: "ONCALL_RESOLUTION_BUCKETS_SECONDS",
      buckets: ONCALL_RESOLUTION_BUCKETS_SECONDS,
      sloSeconds: 0.1,
      series: "openwind_oncall_resolution_duration_seconds_bucket",
    },
    {
      name: "dispatch",
      constant: "NOTIFICATION_DISPATCH_BUCKETS_SECONDS",
      buckets: NOTIFICATION_DISPATCH_BUCKETS_SECONDS,
      sloSeconds: 2,
      series: "openwind_notification_dispatch_duration_seconds_bucket",
    },
  ];

  it("reads the resolution alert's threshold from the rules", () => {
    expect(
      alertThresholds("openwind_oncall_resolution_duration_seconds_bucket"),
    ).toEqual([0.1]);
  });

  for (const { name, constant, buckets, sloSeconds, series } of cases) {
    it(`${name}: is applied to its histogram in metrics.ts`, () => {
      const applied = metricsSource.match(
        new RegExp(`explicitBucketBoundaries:\\s*${constant}`, "g"),
      );

      expect(applied).toHaveLength(1);
    });

    it(`${name}: keeps a finite bucket above every threshold, and a boundary at each`, () => {
      const thresholds = [...new Set([sloSeconds, ...alertThresholds(series)])];

      expect(Math.max(...buckets)).toBeGreaterThan(Math.max(...thresholds));
      for (const threshold of thresholds) {
        expect(buckets).toContain(threshold);
      }
    });

    it(`${name}: is in seconds, not milliseconds, and strictly ascending`, () => {
      // OTel's default boundaries are millisecond-scale (0, 5 ... 10000); pasting
      // them here would put every observation in the first bucket.
      expect(Math.max(...buckets)).toBeLessThanOrEqual(60);
      expect(Math.min(...buckets)).toBeLessThan(0.1);
      const sorted = [...buckets].sort((a, b) => a - b);
      expect(buckets).toEqual(sorted);
      expect(new Set(sorted).size).toBe(sorted.length);
    });
  }

  it("the on-call resolution histogram is read through its _bucket series by an alert", () => {
    expect(metricsReferencedByRules()).toContain(
      "openwind_oncall_resolution_duration_seconds_bucket",
    );
  });
});
