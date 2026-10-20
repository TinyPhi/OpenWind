import { describe, it, expect } from "vitest";
import {
  RETENTION_BOUNDS,
  RetentionFieldsSchema,
  RetentionPatchSchema,
} from "./retention.js";

describe("RetentionFieldsSchema", () => {
  it("accepts values at both edges of each field's bounds", () => {
    expect(
      RetentionFieldsSchema.safeParse({
        retention_days: RETENTION_BOUNDS.retention_days.min,
        retention_comment_days: RETENTION_BOUNDS.retention_comment_days.max,
        retention_evidence_days: RETENTION_BOUNDS.retention_evidence_days.min,
        retention_hold: true,
      }).success,
    ).toBe(true);
  });

  it("refuses values the sweep would ignore", () => {
    for (const bad of [
      { retention_days: 6 },
      { retention_days: 3651 },
      { retention_comment_days: 29 },
      { retention_evidence_days: 364 },
      { retention_evidence_days: 7301 },
      { retention_days: 10.5 },
      { retention_hold: "yes" },
    ]) {
      expect(RetentionFieldsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("RetentionPatchSchema", () => {
  it("requires at least one retention field", () => {
    expect(RetentionPatchSchema.safeParse({}).success).toBe(false);
    expect(
      RetentionPatchSchema.safeParse({ confirmShorten: true }).success,
    ).toBe(false);
  });

  it("allows null to clear and confirmShorten alongside a field", () => {
    expect(
      RetentionPatchSchema.safeParse({
        retention_days: null,
        retention_hold: null,
        confirmShorten: true,
      }).success,
    ).toBe(true);
  });

  it("refuses out-of-bounds values and unknown keys", () => {
    expect(RetentionPatchSchema.safeParse({ retention_days: 1 }).success).toBe(
      false,
    );
    expect(
      RetentionPatchSchema.safeParse({
        retention_days: 30,
        rate_limit_per_min: 5,
      }).success,
    ).toBe(false);
  });
});
