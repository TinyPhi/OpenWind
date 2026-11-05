import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockGetUser = vi.fn();
vi.mock("../authProvider.js", () => ({
  userManager: { getUser: (...a: unknown[]) => mockGetUser(...a) },
}));

const { reportClientError, resetClientErrorReportingForTests } =
  await import("./report-client-error.js");

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const fetchMock = vi.fn();

beforeEach(() => {
  resetClientErrorReportingForTests();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  mockGetUser.mockResolvedValue({ access_token: "tok" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportClientError (#810)", () => {
  it("posts the error to /api/client-errors with the bearer token and the page path only", async () => {
    await reportClientError(new Error("chunk failed"), "\n at Records");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe("/api/client-errors");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body).toMatchObject({
      kind: "route_boundary",
      message: "chunk failed",
      componentStack: "\n at Records",
      path: window.location.pathname,
    });
  });

  it("truncates to the API's caps", async () => {
    const big = new Error("m".repeat(5_000));
    big.stack = "s".repeat(20_000);
    await reportClientError(big, "c".repeat(20_000));
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, FetchInit])[1].body as string,
    ) as Record<string, string>;
    expect(body.message).toHaveLength(1_000);
    expect(body.stack).toHaveLength(8_000);
    expect(body.componentStack).toHaveLength(4_000);
  });

  it("sends the same error once", async () => {
    await reportClientError(new Error("again"));
    await reportClientError(new Error("again"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after five different errors in one page load", async () => {
    for (let i = 0; i < 8; i++) await reportClientError(new Error(`e${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("sends nothing without a signed-in user", async () => {
    mockGetUser.mockResolvedValue(null);
    await reportClientError(new Error("anon"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws, whatever fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(reportClientError(new Error("x"))).resolves.toBeUndefined();
    mockGetUser.mockRejectedValue(new Error("auth down"));
    await expect(reportClientError(new Error("y"))).resolves.toBeUndefined();
  });
});
