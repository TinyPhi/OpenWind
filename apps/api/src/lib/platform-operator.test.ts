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

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock("@platform/logger", () => ({ logger: { warn: mockWarn } }));

const { isPlatformOperatorTenant, denyUnlessPlatformOperator } =
  await import("./platform-operator.js");

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

describe("denyUnlessPlatformOperator", () => {
  beforeEach(() => {
    mockEnv.PLATFORM_ORG_ID = "org-platform";
    mockEnv.NODE_ENV = "production";
    mockWarn.mockClear();
  });

  it("lets the platform org through without logging", () => {
    expect(denyUnlessPlatformOperator("org-platform", "/admin/tenants")).toBe(
      false,
    );
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("denies a customer tenant and logs who and where", () => {
    expect(denyUnlessPlatformOperator("org-customer", "/admin/tenants")).toBe(
      true,
    );
    expect(mockWarn).toHaveBeenCalledWith(
      { tenantId: "org-customer", path: "/admin/tenants" },
      "platform operator fence: access denied",
    );
  });
});
