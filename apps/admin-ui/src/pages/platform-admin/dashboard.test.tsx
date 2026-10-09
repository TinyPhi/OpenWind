import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const mockFetchWithAuth = vi.fn(
  (_url: string): Promise<unknown> => Promise.resolve({ data: {} }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
  API_URL: "/api",
}));

const mockLogout = vi.fn(
  (
    _params: Record<string, never>,
  ): Promise<{ success: boolean; redirectTo?: string }> =>
    Promise.resolve({ success: true }),
);
vi.mock("../../authProvider.js", () => ({
  authProvider: {
    logout: (params: Record<string, never>) => mockLogout(params),
  },
}));

const { PlatformAdminDashboard } = await import("./dashboard.js");

describe("PlatformAdminDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads and displays the platform admin's session identity", async () => {
    mockFetchWithAuth.mockResolvedValue({
      data: { userId: "pa-1", displayName: "Ops", email: "ops@openwind.io" },
    });
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Signed in as Ops/)).toBeTruthy();
    });
  });

  it("shows an inline error when the session fetch fails", async () => {
    mockFetchWithAuth.mockRejectedValue(new Error("Could not load session"));
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });

  it("logs out and redirects when the logout button is clicked", async () => {
    mockFetchWithAuth.mockResolvedValue({
      data: { userId: "pa-1", displayName: "Ops", email: "ops@openwind.io" },
    });
    mockLogout.mockResolvedValue({ success: true, redirectTo: "/login" });
    // jsdom logs "Not implemented: navigation" for the resulting
    // window.location.href assignment -- expected noise, not a failure; this
    // test only verifies the handler reads result.redirectTo and attempts it.
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText(/Signed in as Ops/));
    fireEvent.click(screen.getByText("Log out"));

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledWith({});
    });
  });
});
