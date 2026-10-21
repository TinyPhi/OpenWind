import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import "../i18n.js";

const mockFetchWithAuth = vi.fn<(url: string) => Promise<unknown>>();
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { AccessGate, resetAccessGateForTests } =
  await import("./access-gate.js");

function refused(code: string): Error & { code: string } {
  // fetchWithAuth's errors carry the API's error code on `code` (lib/api.ts).
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

function renderGate(): void {
  render(
    <AccessGate>
      <p>App page</p>
    </AccessGate>,
  );
}

// docs/specs/tenant-access-gate.md R3.
describe("AccessGate", () => {
  beforeEach(() => {
    resetAccessGateForTests();
    mockFetchWithAuth.mockReset();
  });
  afterEach(() => cleanup());

  it("shows 'Checking your access…' until the API allows the login", async () => {
    let allow: (v: unknown) => void = () => {};
    mockFetchWithAuth.mockReturnValueOnce(
      new Promise((r) => {
        allow = r;
      }),
    );
    renderGate();

    expect(screen.getByText("Checking your access…")).toBeDefined();
    expect(screen.queryByText("App page")).toBeNull();

    allow({ data: { allowed: true } });
    await waitFor(() => expect(screen.getByText("App page")).toBeDefined());
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/auth/access");
  });

  it("asks once per page load, however often it mounts", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: { allowed: true } });
    renderGate();
    await waitFor(() => expect(screen.getByText("App page")).toBeDefined());
    cleanup();
    renderGate();
    await waitFor(() => expect(screen.getByText("App page")).toBeDefined());
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("keeps the page hidden while a refusal moves the browser to access-denied", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(refused("NO_ROLE"));
    renderGate();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("App page")).toBeNull();
    expect(screen.getByText("Checking your access…")).toBeDefined();
    expect(screen.queryByText("Try again")).toBeNull();
  });

  it("offers a retry when the check itself fails, and lets the login through after it", async () => {
    mockFetchWithAuth
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ data: { allowed: true } });
    renderGate();

    await waitFor(() =>
      expect(
        screen.getByText("We couldn't check your access just now."),
      ).toBeDefined(),
    );
    expect(screen.queryByText("App page")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("App page")).toBeDefined());
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });
});
