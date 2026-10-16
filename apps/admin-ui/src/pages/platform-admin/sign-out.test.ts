import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLogout = vi.fn();
vi.mock("../../authProvider.js", () => ({
  authProvider: { logout: (...args: unknown[]) => mockLogout(...args) },
}));

const mockFetchWithAuth = vi.fn();
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
  API_URL: "/api",
}));

const { signOutPlatformAdmin } = await import("./sign-out.js");

describe("signOutPlatformAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogout.mockResolvedValue({ success: true, redirectTo: "/login" });
  });

  it("ends the MFA session on the server, then signs out", async () => {
    mockFetchWithAuth.mockResolvedValueOnce(null);

    expect(await signOutPlatformAdmin()).toBe("/login");

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/platform-admin/mfa/end",
      { method: "POST" },
    );
    expect(mockFetchWithAuth.mock.invocationCallOrder[0]).toBeLessThan(
      mockLogout.mock.invocationCallOrder[0]!,
    );
  });

  it("still signs out when ending the server session fails", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("offline"));

    expect(await signOutPlatformAdmin()).toBe("/login");
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
