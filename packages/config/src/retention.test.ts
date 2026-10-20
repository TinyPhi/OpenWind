import { describe, it, expect } from "vitest";
import {
  RETENTION_BOUNDS,
  TenantRetentionConfigSchema,
  UpdateTenantRetentionSchema,
} from "./retention.js";

describe("TenantRetentionConfigSchema", () => {
  it("accepts valid retention values at bounds and midpoints", () => {
    const valid = {
      retention_days: 90,
      retention_comment_days: 180,
      retention_evidence_days: 2555,
      retention_hold: true,
    };
    expect(TenantRetentionConfigSchema.parse(valid)).toEqual(valid);

    const minBounds = {
      retention_days: RETENTION_BOUNDS.noiseDays.min,
      retention_comment_days: RETENTION_BOUNDS.commentDays.min,
      retention_evidence_days: RETENTION_BOUNDS.evidenceDays.min,
      retention_hold: false,
    };
    expect(TenantRetentionConfigSchema.parse(minBounds)).toEqual(minBounds);

    const maxBounds = {
      retention_days: RETENTION_BOUNDS.noiseDays.max,
      retention_comment_days: RETENTION_BOUNDS.commentDays.max,
      retention_evidence_days: RETENTION_BOUNDS.evidenceDays.max,
    };
    expect(TenantRetentionConfigSchema.parse(maxBounds)).toEqual(maxBounds);
  });

  it("rejects values below the minimum floors", () => {
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_days: 6 }),
    ).toThrow();
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_comment_days: 29 }),
    ).toThrow();
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_evidence_days: 364 }),
    ).toThrow();
  });

  it("rejects values above the maximum ceilings", () => {
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_days: 3651 }),
    ).toThrow();
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_comment_days: 3651 }),
    ).toThrow();
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_evidence_days: 7301 }),
    ).toThrow();
  });

  it("rejects non-integer values", () => {
    expect(() =>
      TenantRetentionConfigSchema.parse({ retention_days: 30.5 }),
    ).toThrow();
  });
});

describe("UpdateTenantRetentionSchema", () => {
  it("accepts partial updates with confirmShorten flag", () => {
    const update = {
      retention_days: 30,
      confirmShorten: true,
    };
    expect(UpdateTenantRetentionSchema.parse(update)).toEqual(update);
  });

  it("rejects empty update payloads", () => {
    expect(() => UpdateTenantRetentionSchema.parse({})).toThrow(
      "At least one retention field must be provided to update",
    );
    expect(() =>
      UpdateTenantRetentionSchema.parse({ confirmShorten: true }),
    ).toThrow("At least one retention field must be provided to update");
  });

  it("allows setting only retention_hold", () => {
    expect(UpdateTenantRetentionSchema.parse({ retention_hold: true })).toEqual(
      {
        retention_hold: true,
      },
    );
  });
});
