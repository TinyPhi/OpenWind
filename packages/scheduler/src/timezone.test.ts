import { describe, it, expect } from "vitest";
import { isValidTimezone } from "./timezone.js";

describe("isValidTimezone", () => {
  it("accepts a valid IANA timezone", () => {
    // Avoid asserting on a specific zone name beyond "UTC" -- ICU/tzdata
    // version differences across Node builds mean not every alias (e.g.
    // "Asia/Kolkata" vs "Asia/Calcutta") is guaranteed present everywhere;
    // asserting against the runtime's own supported-zone list keeps this
    // test environment-independent while still exercising the real function.
    expect(isValidTimezone("America/New_York")).toBe(true);
    const [firstSupported] = Intl.supportedValuesOf("timeZone");
    expect(isValidTimezone(firstSupported!)).toBe(true);
  });

  it("accepts the bare 'UTC' identifier (schedule_rules.timezone's own DB default) even when Intl.supportedValuesOf('timeZone') omits it on this runtime", () => {
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("rejects an invalid timezone string", () => {
    expect(isValidTimezone("Not/A_Timezone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
