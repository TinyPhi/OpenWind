import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRemoveUser = vi.fn((): Promise<void> => Promise.resolve());
vi.mock("../authProvider.js", () => ({
  userManager: { removeUser: (): Promise<void> => mockRemoveUser() },
}));

const mockEmitSessionEnd = vi.fn((): void => {});
vi.mock("./session-events.js", () => ({
  emitSessionEnd: (): void => mockEmitSessionEnd(),
}));

const {
  isSessionEndingUnauthorized,
  endSessionAndRedirectToLogin,
  consumeSessionExpiredNotice,
  resetSessionExpiryForTests,
} = await import("./session-expiry.js");

const mockReplace = vi.fn((_url: string): void => {});
const originalLocation = window.location;

function setPath(pathname: string): void {
  // jsdom doesn't implement navigation; swap in a stub location for these tests.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname, replace: (url: string): void => mockReplace(url) },
  });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("isSessionEndingUnauthorized", () => {
  it.each([
    [401, "UNAUTHORIZED", true],
    [401, undefined, true],
    [401, "INVALID_CODE", false],
    [403, "PLATFORM_ADMIN_TENANT_ACCESS_DENIED", false],
    [403, undefined, false],
    [500, undefined, false],
  ] as const)("status %i with error %s -> %s", (status, code, expected) => {
    expect(isSessionEndingUnauthorized(status, code)).toBe(expected);
  });
});

describe("endSessionAndRedirectToLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionExpiryForTests();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("clears the session, leaves a notice, and sends a tenant page to /login", async () => {
    setPath("/records/tickets");

    endSessionAndRedirectToLogin();
    await flush();

    expect(mockEmitSessionEnd).toHaveBeenCalledTimes(1);
    expect(mockRemoveUser).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/login");
    expect(consumeSessionExpiredNotice()).toBe(true);
  });

  it("sends a platform-admin page to /platform-admin/login", async () => {
    setPath("/platform-admin/dashboard");

    endSessionAndRedirectToLogin();
    await flush();

    expect(mockReplace).toHaveBeenCalledWith("/platform-admin/login");
  });

  it("redirects only once when many requests fail together", async () => {
    setPath("/dashboard");

    endSessionAndRedirectToLogin();
    endSessionAndRedirectToLogin();
    endSessionAndRedirectToLogin();
    await flush();

    expect(mockRemoveUser).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it.each(["/login", "/platform-admin/login", "/auth/callback"])(
    "does nothing when already on %s (no redirect loop)",
    async (path) => {
      setPath(path);

      endSessionAndRedirectToLogin();
      await flush();

      expect(mockRemoveUser).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
      expect(consumeSessionExpiredNotice()).toBe(false);
    },
  );

  it("still redirects when clearing the stored user fails", async () => {
    setPath("/dashboard");
    mockRemoveUser.mockRejectedValueOnce(new Error("storage blocked"));

    endSessionAndRedirectToLogin();
    await flush();

    expect(mockReplace).toHaveBeenCalledWith("/login");
  });
});

describe("consumeSessionExpiredNotice", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns true once, then false", () => {
    window.sessionStorage.setItem("ow:auth-notice", "session_expired");

    expect(consumeSessionExpiredNotice()).toBe(true);
    expect(consumeSessionExpiredNotice()).toBe(false);
  });
});
