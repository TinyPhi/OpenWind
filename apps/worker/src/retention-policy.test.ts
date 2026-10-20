import { describe, it, expect } from "vitest";
import { resolveRetentionPolicy } from "./retention-policy.js";

describe("resolveRetentionPolicy", () => {
  it("uses platform defaults for an empty or missing config", () => {
    for (const cfg of [{}, null, undefined]) {
      expect(resolveRetentionPolicy(cfg)).toEqual({
        hold: false,
        noiseDays: 90,
        commentDays: 365,
        evidenceDays: 2555,
      });
    }
  });

  it("applies valid per-tenant overrides", () => {
    expect(
      resolveRetentionPolicy({
        retention_days: 30,
        retention_comment_days: 180,
        retention_evidence_days: 400,
      }),
    ).toEqual({
      hold: false,
      noiseDays: 30,
      commentDays: 180,
      evidenceDays: 400,
    });
  });

  it("falls back per field on invalid values, never shortening evidence below its floor", () => {
    const p = resolveRetentionPolicy({
      retention_days: -5,
      retention_comment_days: "soon",
      retention_evidence_days: 1,
    });
    expect(p.noiseDays).toBe(90);
    expect(p.commentDays).toBe(365);
    expect(p.evidenceDays).toBe(2555);
  });

  it("fails closed when the whole config is not an object", () => {
    expect(resolveRetentionPolicy("x").hold).toBe(true);
    expect(resolveRetentionPolicy([]).hold).toBe(true);
  });

  it("rejects a per-tenant window below the 7-day floor", () => {
    expect(resolveRetentionPolicy({ retention_days: 1 }).noiseDays).toBe(90);
  });

  it("treats retention_hold: true as a hold and a malformed hold as a hold too", () => {
    expect(resolveRetentionPolicy({ retention_hold: true }).hold).toBe(true);
    expect(resolveRetentionPolicy({ retention_hold: "yes" }).hold).toBe(true);
    expect(resolveRetentionPolicy({ retention_hold: false }).hold).toBe(false);
  });
});

describe("resolveRetentionPolicy bounds come from the shared schema", () => {
  it("falls back per field for a value outside the configured bounds", () => {
    expect(
      resolveRetentionPolicy({
        retention_days: 6,
        retention_comment_days: 29,
        retention_evidence_days: 7301,
      }),
    ).toEqual({
      hold: false,
      noiseDays: 90,
      commentDays: 365,
      evidenceDays: 2555,
    });
  });

  it("treats a null cleared key as unset, not as a hold", () => {
    expect(
      resolveRetentionPolicy({ retention_days: null, retention_hold: null }),
    ).toEqual({
      hold: false,
      noiseDays: 90,
      commentDays: 365,
      evidenceDays: 2555,
    });
  });
});
