import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import { useLoginOrgBranding } from "./use-login-org-branding.js";

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const mockFetch = vi.fn();

function okBody(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLoginOrgBranding", () => {
  it("is the generic page at once, with no request, when there is no key", () => {
    const { result } = renderHook(() => useLoginOrgBranding(null));

    expect(result.current).toEqual({ status: "default" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["uppercase hex", "3F9A1C7E2B4D8A60"],
    ["one character short", "3f9a1c7e2b4d8a6"],
    ["one character long", "3f9a1c7e2b4d8a601"],
    ["a non-hex letter", "3f9a1c7e2b4d8a6g"],
    ["a readable slug", "acme-demo-4821"],
    ["an empty value", ""],
    ["markup", "<script>"],
  ])("never sends %s, and is the generic page", (_label, key) => {
    const { result } = renderHook(() => useLoginOrgBranding(key));

    expect(result.current).toEqual({ status: "default" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("holds the brand's space while loading, then shows the sandbox", async () => {
    let resolve!: (res: Response) => void;
    mockFetch.mockReturnValue(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() =>
      useLoginOrgBranding("3f9a1c7e2b4d8a60"),
    );

    expect(result.current).toEqual({ status: "loading" });

    await act(async () => {
      resolve(
        okBody({ name: " Acme Demo ", logo: "data:image/png;base64,AAAA" }),
      );
    });
    await waitFor(() =>
      expect(result.current).toEqual({
        status: "org",
        name: "Acme Demo",
        logo: "data:image/png;base64,AAAA",
      }),
    );
  });

  it("asks the public endpoint with a plain request, carrying no credentials", async () => {
    mockFetch.mockResolvedValue(okBody({ name: "Acme Demo", logo: null }));

    renderHook(() => useLoginOrgBranding("3f9a1c7e2b4d8a60"));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0] as [string, FetchInit];
    expect(url).toBe("/api/public/org-branding/3f9a1c7e2b4d8a60");
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBeUndefined();
  });

  it.each([
    ["an unknown key (404)", () => new Response("{}", { status: 404 })],
    ["a rate limit (429)", () => new Response("{}", { status: 429 })],
    ["a server error (500)", () => new Response("{}", { status: 500 })],
    ["a null answer", () => okBody(null)],
    ["a nameless answer", () => okBody({ name: "  ", logo: null })],
    ["a wrongly typed answer", () => okBody({ name: 42, logo: "x" })],
    [
      "a logo that is not a raster data URL",
      () =>
        okBody({ name: "Acme Demo", logo: "https://evil.example/pixel.png" }),
    ],
    [
      "an SVG data URL",
      () =>
        okBody({
          name: "Acme Demo",
          logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        }),
    ],
  ])("is the generic page for %s", async (_label, make) => {
    mockFetch.mockResolvedValue(make());

    const { result } = renderHook(() =>
      useLoginOrgBranding("3f9a1c7e2b4d8a60"),
    );

    await waitFor(() => expect(result.current).toEqual({ status: "default" }));
  });

  it("is the generic page when the network fails", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    const { result } = renderHook(() =>
      useLoginOrgBranding("3f9a1c7e2b4d8a60"),
    );

    await waitFor(() => expect(result.current).toEqual({ status: "default" }));
  });

  it("gives up on a lookup that takes longer than four seconds", async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(
      (_url: string, init: FetchInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { result } = renderHook(() =>
      useLoginOrgBranding("3f9a1c7e2b4d8a60"),
    );
    expect(result.current).toEqual({ status: "loading" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4001);
    });

    expect(result.current).toEqual({ status: "default" });
  });

  it("looks up again when the key changes, and ignores the earlier answer", async () => {
    mockFetch
      .mockResolvedValueOnce(okBody({ name: "First Org", logo: null }))
      .mockResolvedValueOnce(okBody({ name: "Second Org", logo: null }));
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useLoginOrgBranding(key),
      { initialProps: { key: "3f9a1c7e2b4d8a60" } },
    );

    rerender({ key: "0011223344556677" });

    await waitFor(() =>
      expect(result.current).toEqual({
        status: "org",
        name: "Second Org",
        logo: null,
      }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts the request when the page goes away", async () => {
    let signal: AbortSignal | undefined;
    mockFetch.mockImplementation((_url: string, init: FetchInit) => {
      signal = init.signal ?? undefined;
      return new Promise(() => undefined);
    });
    const { unmount } = renderHook(() =>
      useLoginOrgBranding("3f9a1c7e2b4d8a60"),
    );
    await waitFor(() => expect(signal).toBeDefined());

    unmount();

    expect(signal?.aborted).toBe(true);
  });
});
