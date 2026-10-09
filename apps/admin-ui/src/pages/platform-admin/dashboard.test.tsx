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

// Shallow-mocked: this file tests dashboard.tsx's own list/refresh/session/logout
// logic, not the modal's or row actions' internals, which have their own test files.
vi.mock("./create-sandbox-modal.js", () => ({
  CreateSandboxModal: (props: { open: boolean }) =>
    props.open ? <div>Create sandbox modal open</div> : null,
}));
vi.mock("./sandbox-row-actions.js", () => ({
  SandboxRowActions: (props: { tenantName: string }) => (
    <div>Row actions for {props.tenantName}</div>
  ),
}));

const { PlatformAdminDashboard } = await import("./dashboard.js");

function mockSessionThenSandboxes(sandboxes: unknown[]): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/session")) {
      return Promise.resolve({
        data: { userId: "pa-1", displayName: "Ops", email: "ops@openwind.io" },
      });
    }
    return Promise.resolve({ data: sandboxes });
  });
}

describe("PlatformAdminDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads and displays the platform admin's session identity", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Signed in as Ops/)).toBeTruthy();
    });
  });

  it("shows an empty state when there are no sandboxes", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("No sandboxes yet.")).toBeTruthy();
    });
  });

  it("lists every sandbox with its trial status and row actions", async () => {
    mockSessionThenSandboxes([
      {
        id: "t1",
        name: "Acme Sandbox",
        isSandbox: true,
        createdAt: "2026-10-01T00:00:00Z",
        trialStatus: "active",
      },
    ]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Acme Sandbox")).toBeTruthy();
      expect(screen.getByText("active")).toBeTruthy();
      expect(screen.getByText("Row actions for Acme Sandbox")).toBeTruthy();
    });
  });

  it("shows an inline error when the sandbox list fails to load", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.endsWith("/session")) {
        return Promise.resolve({ data: {} });
      }
      return Promise.reject(new Error("Could not load sandboxes"));
    });
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });

  it("opens the create-sandbox modal when the button is clicked", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("No sandboxes yet."));
    fireEvent.click(screen.getByText("Create sandbox"));

    expect(screen.getByText("Create sandbox modal open")).toBeTruthy();
  });

  it("re-fetches the list when Refresh is clicked", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("No sandboxes yet."));
    const callsBefore = mockFetchWithAuth.mock.calls.length;
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("logs out and redirects when the logout button is clicked", async () => {
    mockSessionThenSandboxes([]);
    mockLogout.mockResolvedValue({ success: true, redirectTo: "/login" });
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText(/Signed in as Ops/));
    fireEvent.click(screen.getByText("Log out"));

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledWith({});
    });
  });
});
