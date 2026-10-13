// Bucket boundaries, in ms, for the temporal scheduler's duration histograms.
//
// They run past the alert thresholds in docker/observability/alert.rules.yml
// (5000 ms tick, 10000 ms fire). With OTel's default boundaries the top finite
// bucket is 10000, so an observation above it lands only in +Inf and
// histogram_quantile returns 10000 at most: `> 10000` could never fire. Keep a
// finite bucket above every threshold an alert rule uses.
export const SCHEDULE_DURATION_BUCKETS_MS: number[] = [
  50, 100, 250, 500, 1000, 2500, 5000, 7500, 10000, 30000, 60000,
];
