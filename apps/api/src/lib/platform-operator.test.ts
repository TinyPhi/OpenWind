import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    PLATFORM_ORG_ID: undefined as string | undefined,
    NODE_ENV: "test" as string,
  },
}));
vi.mock("@platform/config", () => ({
  get env() {
    return mockEnv;
  },
}));

const { isPlatformOperatorTenant } = await import("./platform-operator.js");

describe("isPlatformOperatorTenant", () => {
  beforeEach(() => {
    mockEnv.PLATFORM_ORG_ID = undefined;
    mockEnv.NODE_ENV = "test";
  });

  it("accepts only the platform org when one is configured", () => {
    mockEnv.PLATFORM_ORG_ID = "org-platform";
    expect(isPlatformOperatorTenant("org-platform")).toBe(true);
    expect(isPlatformOperatorTenant("org-customer")).toBe(false);
  });

  it("accepts any tenant in dev and test when none is configured", () => {
    expect(isPlatformOperatorTenant("anyone")).toBe(true);
    mockEnv.NODE_ENV = "development";
    expect(isPlatformOperatorTenant("anyone")).toBe(true);
  });

  it("refuses everyone in production when none is configured", () => {
    mockEnv.NODE_ENV = "production";
    expect(isPlatformOperatorTenant("anyone")).toBe(false);
  });
});
