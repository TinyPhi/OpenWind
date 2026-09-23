import { describe, it, expect } from "vitest";
import { isValidTimezone } from "./timezone.js";

describe("isValidTimezone", () => {
  it("accepts a valid IANA timezone", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    const [firstSupported] = Intl.supportedValuesOf("timeZone");
    expect(isValidTimezone(firstSupported!)).toBe(true);
  });

  it("accepts the bare 'UTC' identifier (schedule_rules.timezone's own DB default)", () => {
    expect(isValidTimezone("UTC")).toBe(true);
  });

  // 2026-09-22 regression (real user report): the old Set-membership check
  // against Intl.supportedValuesOf('timeZone') rejected "Asia/Kolkata" on a
  // runtime whose ICU build enumerates the legacy alias "Asia/Calcutta"
  // instead -- both name the same zone and both are valid IANA identifiers,
  // so both must validate regardless of which one that runtime's
  // supportedValuesOf() happens to prefer.
  it("accepts both a zone's modern name and its legacy alias, whichever this runtime's Intl.supportedValuesOf('timeZone') does or doesn't enumerate", () => {
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("Asia/Calcutta")).toBe(true);
  });

  it("rejects an invalid timezone string", () => {
    expect(isValidTimezone("Not/A_Timezone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
