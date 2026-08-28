import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mockFetchWithAuth = vi.fn();
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const { useApiKeyActions, API_KEY_ACTION_CONFIRM_COPY } =
  await import("./use-api-key-actions.js");

describe("useApiKeyActions", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
  });

  it("revoke calls DELETE /api-keys/:id and returns true on success", async () => {
    mockFetchWithAuth.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useApiKeyActions());

    let ok = false;
    await act(async () => {
      ok = await result.current.revoke("key-1");
    });

    expect(ok).toBe(true);
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/api-keys/key-1", {
      method: "DELETE",
    });
  });

  it("revoke returns false and sets error on failure", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useApiKeyActions());

    let ok = true;
    await act(async () => {
      ok = await result.current.revoke("key-1");
    });

    expect(ok).toBe(false);
    expect(result.current.error).toBe("boom");
  });

  it("rotate calls POST /api-keys/:id/rotate and returns the new key data", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { id: "key-2", key: "sk_live_new", expiresAt: null },
    });
    const { result } = renderHook(() => useApiKeyActions());

    let out: unknown;
    await act(async () => {
      out = await result.current.rotate("key-1");
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/api-keys/key-1/rotate",
      { method: "POST" },
    );
    expect(out).toEqual({ id: "key-2", key: "sk_live_new", expiresAt: null });
  });

  it("emergencyRotate calls POST /api-keys/:id/emergency-rotate", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { id: "key-2", key: "sk_live_new", expiresAt: null },
    });
    const { result } = renderHook(() => useApiKeyActions());

    await act(async () => {
      await result.current.emergencyRotate("key-1");
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/api-keys/key-1/emergency-rotate",
      { method: "POST" },
    );
  });

  it("emergencyRotate returns null and sets error on failure", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("rejected"));
    const { result } = renderHook(() => useApiKeyActions());

    let out: unknown = "not-null";
    await act(async () => {
      out = await result.current.emergencyRotate("key-1");
    });

    expect(out).toBeNull();
    expect(result.current.error).toBe("rejected");
  });
});

// ADR-012 Phase A spec R5: Emergency Rotate's warning must never be
// identical to Rotate's — the whole point is that it's the more severe
// action (zero grace, breaks immediately).
describe("API_KEY_ACTION_CONFIRM_COPY (ADR-012 Phase A spec R5)", () => {
  it("gives rotate and emergency-rotate distinct warning copy", () => {
    expect(API_KEY_ACTION_CONFIRM_COPY.rotate.message).not.toBe(
      API_KEY_ACTION_CONFIRM_COPY["emergency-rotate"].message,
    );
  });

  it("emergency-rotate's warning explicitly says the integration breaks immediately", () => {
    expect(API_KEY_ACTION_CONFIRM_COPY["emergency-rotate"].message).toMatch(
      /breaks immediately/i,
    );
  });

  it("rotate's warning describes a grace period; emergency-rotate's explicitly says there is none", () => {
    expect(API_KEY_ACTION_CONFIRM_COPY.rotate.message).toMatch(/24 more hours/);
    expect(API_KEY_ACTION_CONFIRM_COPY["emergency-rotate"].message).toMatch(
      /no 24-hour grace period/,
    );
  });
});
