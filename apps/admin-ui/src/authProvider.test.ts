import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as OidcClient from "oidc-client-ts";

let capturedUserUnloadedCallback: (() => void) | undefined;
let capturedAccessTokenExpiredCallback: (() => void) | undefined;

const mockSigninSilent = vi.fn();
const mockGetUser = vi.fn().mockResolvedValue(null);
const mockAddUserLoaded = vi.fn();
const mockAddUserUnloaded = vi.fn((cb: () => void) => {
  capturedUserUnloadedCallback = cb;
});
const mockAddAccessTokenExpired = vi.fn((cb: () => void) => {
  capturedAccessTokenExpiredCallback = cb;
});
const mockSignoutRedirect = vi.fn();
const mockRemoveUser = vi.fn();
const mockClearStaleState = vi.fn();

vi.mock("oidc-client-ts", async (importOriginal) => {
  const actual = await importOriginal<typeof OidcClient>();
  return {
    // Real error classes so authProvider's `instanceof` checks behave as in prod.
    ErrorResponse: actual.ErrorResponse,
    ErrorTimeout: actual.ErrorTimeout,
    UserManager: vi.fn().mockImplementation(function UserManager() {
      return {
        signinSilent: mockSigninSilent,
        getUser: mockGetUser,
        signoutRedirect: mockSignoutRedirect,
        removeUser: mockRemoveUser,
        clearStaleState: mockClearStaleState,
        events: {
          addUserLoaded: mockAddUserLoaded,
          addUserUnloaded: mockAddUserUnloaded,
          addAccessTokenExpired: mockAddAccessTokenExpired,
        },
      };
    }),
    WebStorageStateStore: vi.fn(),
  };
});

vi.mock("@refinedev/core", () => ({}));

const { silentRefresh, authProvider } = await import("./authProvider.js");
const { onSessionEnd } = await import("./lib/session-events.js");
const { ErrorResponse, ErrorTimeout } = await import("oidc-client-ts");

describe("silentRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the new access_token on success", async () => {
    mockSigninSilent.mockResolvedValue({ access_token: "tok-123" });

    const result = await silentRefresh();

    expect(result).toBe("tok-123");
  });

  it("returns null and emits session end when the authorization server rejects the refresh (ErrorResponse)", async () => {
    const sessionEndListener = vi.fn();
    const unsubscribe = onSessionEnd(sessionEndListener);
    mockSigninSilent.mockRejectedValue(
      new ErrorResponse({ error: "invalid_grant" }),
    );

    const result = await silentRefresh();

    expect(result).toBeNull();
    expect(sessionEndListener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it.each([
    ["a plain network Error", () => new Error("Network error")],
    ["a fetch TypeError", () => new TypeError("Failed to fetch")],
    ["an ErrorTimeout", () => new ErrorTimeout("IFrame timed out")],
  ])(
    "returns null without emitting session end when signinSilent rejects with %s (transient failure)",
    async (_label, makeError) => {
      const sessionEndListener = vi.fn();
      const unsubscribe = onSessionEnd(sessionEndListener);
      mockSigninSilent.mockRejectedValue(makeError());

      const result = await silentRefresh();

      expect(result).toBeNull();
      expect(sessionEndListener).not.toHaveBeenCalled();
      unsubscribe();
    },
  );

  it("returns null and emits session end when signinSilent resolves with no access token", async () => {
    const sessionEndListener = vi.fn();
    const unsubscribe = onSessionEnd(sessionEndListener);
    mockSigninSilent.mockResolvedValue(null);

    const result = await silentRefresh();

    expect(result).toBeNull();
    expect(sessionEndListener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("shares one in-flight signinSilent() call across concurrent callers (single-flight)", async () => {
    let resolveSignin: (v: { access_token: string }) => void;
    mockSigninSilent.mockReturnValue(
      new Promise((resolve) => {
        resolveSignin = resolve;
      }),
    );

    const first = silentRefresh();
    const second = silentRefresh();
    const third = silentRefresh();

    expect(mockSigninSilent).toHaveBeenCalledTimes(1);

    resolveSignin!({ access_token: "shared-tok" });
    const [r1, r2, r3] = await Promise.all([first, second, third]);

    expect(r1).toBe("shared-tok");
    expect(r2).toBe("shared-tok");
    expect(r3).toBe("shared-tok");
  });

  it("starts a fresh signinSilent() call after the previous one has settled", async () => {
    mockSigninSilent.mockResolvedValueOnce({ access_token: "first" });
    const firstResult = await silentRefresh();
    expect(firstResult).toBe("first");

    mockSigninSilent.mockResolvedValueOnce({ access_token: "second" });
    const secondResult = await silentRefresh();
    expect(secondResult).toBe("second");

    expect(mockSigninSilent).toHaveBeenCalledTimes(2);
  });
});

describe("authProvider.logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue(null);
  });

  it("returns success with no redirectTo when signoutRedirect succeeds — the browser navigates away before Refine acts on the return value", async () => {
    mockSignoutRedirect.mockResolvedValue(undefined);

    const result = await authProvider.logout({});

    expect(mockSignoutRedirect).toHaveBeenCalled();
    expect(mockRemoveUser).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it("falls back to a local-only logout when signoutRedirect throws (Zitadel unreachable)", async () => {
    mockSignoutRedirect.mockRejectedValue(new Error("network timeout"));

    const result = await authProvider.logout({});

    expect(mockRemoveUser).toHaveBeenCalled();
    expect(result).toEqual({ success: true, redirectTo: "/login" });
  });

  it("emits session end event to clear module caches on logout", async () => {
    const sessionEndListener = vi.fn();
    const unsubscribe = onSessionEnd(sessionEndListener);
    mockSignoutRedirect.mockResolvedValue(undefined);

    await authProvider.logout({});

    expect(sessionEndListener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("emits session end event even if signoutRedirect throws", async () => {
    const sessionEndListener = vi.fn();
    const unsubscribe = onSessionEnd(sessionEndListener);
    mockSignoutRedirect.mockRejectedValue(new Error("network timeout"));

    await authProvider.logout({});

    expect(sessionEndListener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("userManager events", () => {
  it("registers listeners for addUserUnloaded and addAccessTokenExpired that emit session end", () => {
    expect(capturedUserUnloadedCallback).toBeDefined();
    expect(capturedAccessTokenExpiredCallback).toBeDefined();

    const sessionEndListener = vi.fn();
    const unsubscribe = onSessionEnd(sessionEndListener);

    capturedUserUnloadedCallback?.();
    expect(sessionEndListener).toHaveBeenCalledTimes(1);

    capturedAccessTokenExpiredCallback?.();
    expect(sessionEndListener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });
});
