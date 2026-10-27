import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/config", () => ({
  env: {
    DATABASE_URL: "postgres://app_user:pw@pgbouncer:5432/platform",
  },
}));

import {
  toPlatformAdminSandboxView,
  toProvisioningProgressView,
  type ProvisioningProgressRow,
} from "./platform-admin-view.js";

describe("toPlatformAdminSandboxView", () => {
  const base = {
    id: "t-1",
    name: "Acme Demo",
    isSandbox: true,
    trialEndsAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
  };

  it("passes the logo through, and null when there is none (R12)", () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    expect(toPlatformAdminSandboxView({ ...base, logo }).logo).toBe(logo);
    expect(toPlatformAdminSandboxView({ ...base, logo: null }).logo).toBeNull();
  });

  it("returns only the allow-listed fields", () => {
    expect(
      Object.keys(toPlatformAdminSandboxView({ ...base, logo: null })).sort(),
    ).toEqual([
      "createdAt",
      "id",
      "isSandbox",
      "logo",
      "name",
      "trialEndsAt",
      "trialStatus",
    ]);
  });
});

describe("toProvisioningProgressView", () => {
  it("maps a completed provisioning job row with rolledBack null", () => {
    const row: ProvisioningProgressRow = {
      id: "job-1",
      status: "completed",
      currentStep: "done",
      completedSteps: 10,
      totalSteps: 10,
      error: null,
      rolledBack: null,
    };

    const view = toProvisioningProgressView(row);
    expect(view).toEqual({
      id: "job-1",
      status: "completed",
      currentStep: "done",
      completedSteps: 10,
      totalSteps: 10,
      error: null,
      rolledBack: null,
    });
  });

  it("maps a failed provisioning job with rolledBack = true (#829)", () => {
    const row: ProvisioningProgressRow = {
      id: "job-failed-rollback",
      status: "failed",
      currentStep: "seed_accounts",
      completedSteps: 3,
      totalSteps: 10,
      error: "ZITADEL_API_ERROR",
      rolledBack: true,
    };

    const view = toProvisioningProgressView(row);
    expect(view.status).toBe("failed");
    expect(view.error).toBe("ZITADEL_API_ERROR");
    expect(view.rolledBack).toBe(true);
  });

  it("maps a failed provisioning job with rolledBack = false (#829)", () => {
    const row: ProvisioningProgressRow = {
      id: "job-failed-no-rollback",
      status: "failed",
      currentStep: "create_org",
      completedSteps: 1,
      totalSteps: 10,
      error: "DELETE_ORG_FAILED",
      rolledBack: false,
    };

    const view = toProvisioningProgressView(row);
    expect(view.status).toBe("failed");
    expect(view.error).toBe("DELETE_ORG_FAILED");
    expect(view.rolledBack).toBe(false);
  });

  it("defaults undefined rolledBack to null", () => {
    const row: ProvisioningProgressRow = {
      id: "job-legacy",
      status: "pending",
      currentStep: null,
      completedSteps: 0,
      totalSteps: 10,
      error: null,
    };

    const view = toProvisioningProgressView(row);
    expect(view.rolledBack).toBeNull();
  });

  it("throws on unexpected status", () => {
    const row: ProvisioningProgressRow = {
      id: "job-invalid",
      status: "unknown_status",
      currentStep: null,
      completedSteps: 0,
      totalSteps: 10,
      error: null,
    };

    expect(() => toProvisioningProgressView(row)).toThrow(
      "unexpected sandbox_provisioning_jobs.status: unknown_status",
    );
  });
});
