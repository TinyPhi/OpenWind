// Bucket boundaries, in SECONDS, for the on-call routing duration histograms.
//
// OTel's default boundaries (0, 5, 10, 25 ... 10000) are millisecond-scale, so
// seconds-valued observations would all land in the first bucket and every
// quantile would read as roughly 5 s regardless of the real latency. These run
// from 1 ms and keep a finite bucket above each SLO threshold in
// docker/observability/alert.rules.yml (0.1 s resolution, 2 s dispatch):
// histogram_quantile returns the top finite bound at most, so without a bucket
// above the threshold `> threshold` could never fire.
export const ONCALL_RESOLUTION_BUCKETS_SECONDS: number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

export const NOTIFICATION_DISPATCH_BUCKETS_SECONDS: number[] = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30,
];
