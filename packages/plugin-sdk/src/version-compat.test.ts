import { describe, it, expect } from "vitest";
import { isPlatformVersionCompatible } from "./version-compat.js";

describe("isPlatformVersionCompatible", () => {
  it("matches an exact version range", () => {
    expect(isPlatformVersionCompatible("1.2.3", "1.2.3")).toBe(true);
  });

  it("rejects a platform version that does not exactly match an exact range", () => {
    expect(isPlatformVersionCompatible("1.2.3", "1.2.4")).toBe(false);
  });

  it("accepts a platform version at or above a >= range", () => {
    expect(isPlatformVersionCompatible(">=1.2.3", "1.2.3")).toBe(true);
    expect(isPlatformVersionCompatible(">=1.2.3", "2.0.0")).toBe(true);
  });

  it("rejects a platform version below a >= range", () => {
    expect(isPlatformVersionCompatible(">=1.2.3", "1.2.2")).toBe(false);
  });

  it("accepts a compatible ^ range within the same major version", () => {
    expect(isPlatformVersionCompatible("^1.2.3", "1.9.0")).toBe(true);
  });

  it("rejects a ^ range across a major version bump", () => {
    expect(isPlatformVersionCompatible("^1.2.3", "2.0.0")).toBe(false);
  });

  it("rejects a ^ range below the stated minor.patch floor", () => {
    expect(isPlatformVersionCompatible("^1.2.3", "1.2.2")).toBe(false);
  });

  it("fails closed on an unparseable range instead of allowing the install", () => {
    expect(isPlatformVersionCompatible("not-a-version", "1.2.3")).toBe(false);
  });

  it("fails closed on an unparseable platform version", () => {
    expect(isPlatformVersionCompatible(">=1.0.0", "not-a-version")).toBe(false);
  });
});
