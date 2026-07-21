import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSigninSilent = vi.fn();
const mockGetUser = vi.fn().mockResolvedValue(null);
const mockAddUserLoaded = vi.fn();

vi.mock("oidc-client-ts", () => ({
  UserManager: vi.fn().mockImplementation(function UserManager() {
    return {
      signinSilent: mockSigninSilent,
      getUser: mockGetUser,
      events: { addUserLoaded: mockAddUserLoaded },
    };
  }),
  WebStorageStateStore: vi.fn(),
}));

vi.mock("@refinedev/core", () => ({}));

const { silentRefresh } = await import("./authProvider.js");

describe("silentRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the new access_token on success", async () => {
    mockSigninSilent.mockResolvedValue({ access_token: "tok-123" });

    const result = await silentRefresh();

    expect(result).toBe("tok-123");
  });

  it("returns null when signinSilent rejects", async () => {
    mockSigninSilent.mockRejectedValue(new Error("refresh failed"));

    const result = await silentRefresh();

    expect(result).toBeNull();
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
