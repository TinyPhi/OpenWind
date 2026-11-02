import { StrictMode } from "react";
import "../../i18n.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  act,
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

// Shallow-mocked: this file tests dashboard.tsx's own wiring (session, sandbox list, stats,
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

const DAY = 86_400_000;
const ACTIVE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Sandbox",
  isSandbox: true,
  createdAt: "2026-10-01T00:00:00Z",
  trialStatus: "active",
  trialEndsAt: new Date(Date.now() + 30 * DAY).toISOString(),
};
const EXPIRING = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Beta Sandbox",
  isSandbox: true,
  createdAt: "2026-10-02T00:00:00Z",
  trialStatus: "active",
  trialEndsAt: new Date(Date.now() + 3 * DAY).toISOString(),
};
const EXPIRED = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Gamma Sandbox",
  isSandbox: true,
  createdAt: "2026-09-01T00:00:00Z",
  trialStatus: "expired",
  trialEndsAt: new Date(Date.now() - 2 * DAY).toISOString(),
};

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
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Signed in as Ops/)).toBeTruthy();
    });
  });

  it("ignores a session response from an effect that was cleaned up (StrictMode)", async () => {
    const pending: Array<(value: unknown) => void> = [];
    mockFetchWithAuth.mockImplementation((url: string) =>
      url.endsWith("/session")
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.resolve({ data: [] }),
    );
    const answerSession = (
      index: number,
      displayName: string,
    ): Promise<void> => {
      const resolve = pending[index];
      if (!resolve) throw new Error(`no session request #${index}`);
      resolve({
        data: { userId: "pa-1", displayName, email: "ops@openwind.io" },
      });
      return Promise.resolve();
    };

    render(
      <StrictMode>
        <PlatformAdminDashboard />
      </StrictMode>,
    );
    await waitFor(() => expect(pending).toHaveLength(2));

    // The live effect's fetch answers first; the cleaned-up effect's fetch answers last.
    await act(() => answerSession(1, "Current"));
    await waitFor(() => screen.getByText(/Signed in as Current/));
    await act(() => answerSession(0, "Stale"));

    expect(screen.queryByText(/Signed in as Stale/)).toBeNull();
    expect(screen.getByText(/Signed in as Current/)).toBeTruthy();
  });

  it("ignores a sandboxes response from a refresh that was superseded by a newer refresh", async () => {
    const pendingSandboxes: Array<(value: unknown) => void> = [];
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.endsWith("/session")) {
        return Promise.resolve({
          data: {
            userId: "pa-1",
            displayName: "Ops",
            email: "ops@openwind.io",
          },
        });
      }
      if (url.includes("/sandboxes")) {
        return new Promise((resolve) => pendingSandboxes.push(resolve));
      }
      return Promise.resolve({ data: [] });
    });

    render(<PlatformAdminDashboard />);
    // Initial mount triggers first sandboxes fetch
    await waitFor(() => expect(pendingSandboxes).toHaveLength(1));

    // Click Refresh button to trigger second sandboxes fetch
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(refreshButton);
    await waitFor(() => expect(pendingSandboxes).toHaveLength(2));

    // Answer the second (newer) fetch first with "Newer Sandbox"
    await act(() => {
      const resolve2 = pendingSandboxes[1];
      if (!resolve2) throw new Error("no second sandboxes request");
      resolve2({
        data: [{ ...ACTIVE, id: "sb-newer", name: "Newer Sandbox" }],
      });
      return Promise.resolve();
    });
    await waitFor(() => screen.getByText("Newer Sandbox"));

    // Answer the first (older, superseded) fetch second with "Older Sandbox"
    await act(() => {
      const resolve1 = pendingSandboxes[0];
      if (!resolve1) throw new Error("no first sandboxes request");
      resolve1({
        data: [{ ...ACTIVE, id: "sb-older", name: "Older Sandbox" }],
      });
      return Promise.resolve();
    });

    // The newer data remains; older data was discarded
    expect(screen.queryByText("Older Sandbox")).toBeNull();
    expect(screen.getByText("Newer Sandbox")).toBeTruthy();
  });

  // Two earlier tests resolved or rejected a sandboxes fetch after unmount and asserted the DOM
  // was empty. After unmount the DOM is empty whatever the code does (React 18 ignores a state
  // update on an unmounted component), so they passed with or without the isMountedRef guard and
  // were removed (#995). The ordering guarantee that matters is the superseded-refresh test above.

  it("fetches the sandbox list, never an all-tenants list", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/platform-admin/sandboxes?limit=500",
      );
    });
    expect(
      mockFetchWithAuth.mock.calls.some(([url]) => url.includes("/tenants")),
    ).toBe(false);
  });

  it("says so when the list is truncated, so a sandbox past the page is not silently invisible (#992)", async () => {
    mockFetchWithAuth.mockImplementation((url: string) =>
      url.endsWith("/session")
        ? Promise.resolve({
            data: {
              userId: "pa-1",
              displayName: "Ops",
              email: "ops@openwind.io",
            },
          })
        : Promise.resolve({ data: [ACTIVE], hasMore: true }),
    );
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("Acme Sandbox"));
    expect(screen.getByRole("status").textContent).toMatch(
      /500 most recent sandboxes/i,
    );
  });

  it("shows no truncation notice when every sandbox is listed (#992)", async () => {
    mockSessionThenSandboxes([ACTIVE]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("Acme Sandbox"));
    expect(screen.queryByText(/most recent sandboxes/i)).toBeNull();
  });

  it("shows an empty state when there are no sandboxes", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("No sandboxes yet.")).toBeTruthy();
    });
  });

  it("lists every sandbox with its row actions menu", async () => {
    mockSessionThenSandboxes([ACTIVE, EXPIRED]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("Acme Sandbox"));
    expect(screen.getByText("Gamma Sandbox")).toBeTruthy();
    expect(screen.getByText("Row actions for Acme Sandbox")).toBeTruthy();
    expect(screen.getByText("Row actions for Gamma Sandbox")).toBeTruthy();
  });

  it("summarises sandboxes and trials in the stat cards", async () => {
    mockSessionThenSandboxes([ACTIVE, EXPIRING, EXPIRED]);
    render(<PlatformAdminDashboard />);

    await waitFor(() =>
      screen.getByText("Sandboxes", { selector: ".stat-title" }),
    );
    expect(statValue("Sandboxes")).toBe("3");
    expect(statValue("Active trials")).toBe("2");
    expect(statValue("Expiring within 7 days")).toBe("1");
    expect(statValue("Expired")).toBe("1");
  });

  it("opens the detail panel with that sandbox's timeline on row click, and closes it", async () => {
    mockSessionThenSandboxes([ACTIVE]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("Acme Sandbox"));
    fireEvent.click(screen.getByText("Acme Sandbox"));

    const panel = screen.getByRole("dialog", { name: "Acme Sandbox details" });
    expect(within(panel).getByText(`Timeline ${ACTIVE.id}`)).toBeTruthy();

    fireEvent.click(within(panel).getByLabelText("Close details"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the global activity timeline", async () => {
    mockSessionThenSandboxes([]);
    render(<PlatformAdminDashboard />);

    await waitFor(() => {
      expect(screen.getByText("Timeline all")).toBeTruthy();
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
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not load sandboxes",
      );
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

  it("shows a loading state until the sandbox list arrives", () => {
    mockFetchWithAuth.mockImplementation((url: string) =>
      url.endsWith("/session")
        ? Promise.resolve({ data: {} })
        : new Promise(() => {}),
    );
    render(<PlatformAdminDashboard />);

    expect(screen.getByLabelText("Loading sandboxes")).toBeTruthy();
    expect(screen.queryByText("No sandboxes yet.")).toBeNull();
  });

  // PR #842 review E: a failed session fetch is deliberately silent -- the identity banner is
  // cosmetic and RequirePlatformAdminMfa already validated the session.
  it("hides the identity banner, with no error, when the session fetch fails", async () => {
    mockFetchWithAuth.mockImplementation((url: string) =>
      url.endsWith("/session")
        ? Promise.reject(new Error("session down"))
        : Promise.resolve({ data: [] }),
    );
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText("No sandboxes yet."));
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
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

  it("shows an inline error when logout fails", async () => {
    mockSessionThenSandboxes([]);
    mockLogout.mockRejectedValue(new Error("identity provider unavailable"));
    render(<PlatformAdminDashboard />);

    await waitFor(() => screen.getByText(/Signed in as Ops/));
    fireEvent.click(screen.getByText("Log out"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "Logout failed. Please try again.",
      );
    });
  });
});
