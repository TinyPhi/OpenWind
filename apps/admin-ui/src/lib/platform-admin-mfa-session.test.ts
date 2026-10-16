import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getPlatformAdminMfaSession,
  setPlatformAdminMfaSession,
  clearPlatformAdminMfaSession,
  addPlatformAdminMfaHeader,
  PLATFORM_ADMIN_MFA_SESSION_HEADER,
} from "./platform-admin-mfa-session.js";

function headerFor(path: string): string | null {
  const headers = new Headers();
  addPlatformAdminMfaHeader(new URL(path, "http://localhost"), headers);
  return headers.get(PLATFORM_ADMIN_MFA_SESSION_HEADER);
}

describe("platform-admin MFA session token", () => {
  afterEach(() => {
    clearPlatformAdminMfaSession();
    vi.restoreAllMocks();
  });

  it("stores, reads back and clears the token", () => {
    expect(getPlatformAdminMfaSession()).toBeNull();

    setPlatformAdminMfaSession("tok-1");
    expect(getPlatformAdminMfaSession()).toBe("tok-1");

    clearPlatformAdminMfaSession();
    expect(getPlatformAdminMfaSession()).toBeNull();
  });

  it("adds the header to platform-admin API requests only", () => {
    setPlatformAdminMfaSession("tok-1");

    expect(headerFor("/api/platform-admin/sandboxes")).toBe("tok-1");
    expect(headerFor("/api/entity-types")).toBeNull();
    expect(headerFor("/api/platform-adminx/sandboxes")).toBeNull();
    expect(headerFor("/platform-admin/dashboard")).toBeNull();
  });

  it("stops using the token once another tab removes it", () => {
    setPlatformAdminMfaSession("tok-1");

    window.localStorage.removeItem("openwind.platformAdminMfaSession");

    expect(getPlatformAdminMfaSession()).toBeNull();
  });

  it("adds nothing when there is no token", () => {
    expect(headerFor("/api/platform-admin/session")).toBeNull();
  });

  it("keeps the token in memory when storage reads but refuses writes (quota)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    setPlatformAdminMfaSession("tok-mem");
    expect(getPlatformAdminMfaSession()).toBe("tok-mem");
  });

  it("keeps working for this page when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    setPlatformAdminMfaSession("tok-mem");
    expect(getPlatformAdminMfaSession()).toBe("tok-mem");
  });
});
