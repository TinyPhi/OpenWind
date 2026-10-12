import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
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

// Shallow-mocked: this file tests dashboard.tsx's own wiring (session, tenant list, stats,
// detail panel, refresh, logout), not the children's internals, which have their own tests.
vi.mock("./create-sandbox-modal.js", () => ({
  CreateSandboxModal: (props: { open: boolean }) =>
    props.open ? <div>Create sandbox modal open</div> : null,
}));
vi.mock("./sandbox-row-actions.js", () => ({
  SandboxRowActions: (props: { tenantName: string }) => (
    <div>Row actions for {props.tenantName}</div>
  ),
}));
vi.mock("./activity-timeline.js", () => ({
  ActivityTimeline: (props: { targetTenantId?: string }) => (
    <div>Timeline {props.targetTenantId ?? "all"}</div>
  ),
}));

const { PlatformAdminDashboard } = await import("./dashboard.js");

const SANDBOX = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Sandbox",
  isSandbox: true,
  createdAt: "2026-10-01T00:00:00Z",
  trialStatus: "active",
};
const CUSTOMER = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Default Org",
  isSandbox: false,
  createdAt: "2026-05-01T00:00:00Z",
  trialStatus: "none",
};

function mockSessionThenTenants(tenants: unknown[]): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/session")) {
      return Promise.resolve({
        data: { userId: "pa-1", displayName: "Ops", email: "ops@openwind.io" },
      });
    }
    return Promise.resolve({ data: tenants });
  });
}

function statValue(label: string): string | null {
  const card = screen
    .getByText(label, { selector: ".stat-title" })
    .closest(".stat-card");
  return card?.querySelector(".stat-value")?.textContent ?? null;
}

describe("PlatformAdminDashboard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads and displays the platform admin's session identity", async () => {
    mockSessionThenTenants([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Signed in as Ops/)).toBeTruthy();
    });
  });

  it("fetches every tenant from /platform-admin/tenants", async () => {
    mockSessionThenTenants([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/platform-admin/tenants",
      );
    });
  });

  it("shows an empty state when there are no tenants", async () => {
    mockSessionThenTenants([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("No tenants yet.")).toBeTruthy();
    });
  });

  it("lists sandbox and customer tenants, with actions only on the sandbox", async () => {
    mockSessionThenTenants([SANDBOX, CUSTOMER]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("Acme Sandbox"));
    expect(screen.getByText("Default Org")).toBeTruthy();
    expect(screen.getByText("Row actions for Acme Sandbox")).toBeTruthy();
    expect(screen.queryByText("Row actions for Default Org")).toBeNull();
  });

  it("summarises the tenant list in the stat cards", async () => {
    mockSessionThenTenants([SANDBOX, CUSTOMER]);
    render(<PlatformAdminDashboard />);

    await waitFor(() =>
      screen.getByText("Total tenants", { selector: ".stat-title" }),
    );
    expect(statValue("Total tenants")).toBe("2");
    expect(statValue("Sandboxes")).toBe("1");
    expect(statValue("Customers")).toBe("1");
    expect(statValue("Active trials")).toBe("1");
    expect(statValue("Expired trials")).toBe("0");
  });

  it("opens the detail panel with that tenant's timeline on row click, and closes it", async () => {
    mockSessionThenTenants([SANDBOX, CUSTOMER]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("Default Org"));
    fireEvent.click(screen.getByText("Default Org"));

    const panel = screen.getByRole("dialog", { name: "Default Org details" });
    expect(within(panel).getByText(`Timeline ${CUSTOMER.id}`)).toBeTruthy();
    expect(within(panel).getByText(/view only/)).toBeTruthy();

    fireEvent.click(within(panel).getByLabelText("Close details"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the global activity timeline", async () => {
    mockSessionThenTenants([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Timeline all")).toBeTruthy();
    });
  });

  it("shows an inline error when the tenant list fails to load", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.endsWith("/session")) {
        return Promise.resolve({ data: {} });
      }
      return Promise.reject(new Error("Could not load tenants"));
    });
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not load tenants",
      );
    });
  });

  it("opens the create-sandbox modal when the button is clicked", async () => {
    mockSessionThenTenants([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("No tenants yet."));
    fireEvent.click(screen.getByText("Create sandbox"));

    expect(screen.getByText("Create sandbox modal open")).toBeTruthy();
  });

  it("re-fetches the list when Refresh is clicked", async () => {
    mockSessionThenTenants([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("No tenants yet."));
    const callsBefore = mockFetchWithAuth.mock.calls.length;
    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      expect(mockFetchWithAuth.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it("logs out and redirects when the logout button is clicked", async () => {
    mockSessionThenTenants([]);
    mockLogout.mockResolvedValue({ success: true, redirectTo: "/login" });
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText(/Signed in as Ops/));
    fireEvent.click(screen.getByText("Log out"));

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledWith({});
    });
  });
});
