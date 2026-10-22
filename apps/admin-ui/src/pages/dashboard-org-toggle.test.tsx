import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// docs/specs/my-org-view.md R1/R4/R9 -- the My View / Org View toggle and the read-only
// "view as subordinate" mode, exercised through the real Dashboard.

vi.mock("@refinedev/core", () => ({
  useGetIdentity: () => ({
    data: { id: "u1", name: "Jane Doe", email: "jane@example.com" },
  }),
}));

vi.mock("../entity-type-context.js", () => ({
  useEntityTypes: () => ({ getTypeById: () => undefined }),
  toTypeSlug: (s: string) => s,
}));

const mockListNotifications = vi.fn(() => Promise.resolve({ data: [] }));
vi.mock("../lib/notifications-client.js", () => ({
  listNotifications: () => mockListNotifications(),
  getUnreadCount: () => Promise.resolve(0),
  markNotificationRead: () => Promise.resolve(),
}));

const EMPTY_MY_VIEW = {
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
  adminWorkflows: [],
  savedViews: [],
  pendingApprovals: { items: [], totalQualifying: 0 },
};

const ORG_VIEW_WITH_REPORTS = {
  hasReports: true,
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
  teamMembers: {
    items: [
      { userId: "emp", name: "Emp Person", ticketCount: 2, overdueCount: 1 },
    ],
  },
};

const ORG_VIEW_NO_REPORTS = {
  ...ORG_VIEW_WITH_REPORTS,
  hasReports: false,
  teamMembers: { items: [] },
};

const routes: Record<string, unknown> = {};
const mockFetchWithAuth = vi.fn((url: string) => {
  const key = Object.keys(routes).find((k) => url.endsWith(k));
  return key !== undefined
    ? Promise.resolve({ data: routes[key] })
    : Promise.reject(new Error(`unexpected ${url}`));
});
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { Dashboard } = await import("./dashboard.js");

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/dashboard/team/:userId" element={<Dashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mockFetchWithAuth.mockClear();
  mockListNotifications.mockClear();
  for (const k of Object.keys(routes)) delete routes[k];
});

describe("Dashboard — My View / Org View toggle", () => {
  it("shows the toggle to a user who has reports", async () => {
    routes["/dashboard/my-view"] = EMPTY_MY_VIEW;
    routes["/dashboard/org-view"] = ORG_VIEW_WITH_REPORTS;

    renderAt("/dashboard");

    expect(
      await screen.findByRole("button", { name: /Org View/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "My View" })).toBeTruthy();
  });

  it("hides the toggle from a user with no reports, whatever their role", async () => {
    routes["/dashboard/my-view"] = EMPTY_MY_VIEW;
    routes["/dashboard/org-view"] = ORG_VIEW_NO_REPORTS;

    renderAt("/dashboard");

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/dashboard/org-view"),
    );
    expect(screen.queryByRole("button", { name: /Org View/ })).toBeNull();
  });

  it("hides the toggle, and still shows My View, when the org view cannot be loaded", async () => {
    routes["/dashboard/my-view"] = EMPTY_MY_VIEW;
    // no /dashboard/org-view route -> the request rejects

    renderAt("/dashboard");

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/dashboard/org-view"),
    );
    expect(screen.queryByRole("button", { name: /Org View/ })).toBeNull();
    expect(screen.getAllByText("My Tickets").length).toBeGreaterThan(0);
  });

  it("switches to the org body in place without a second org-view request", async () => {
    routes["/dashboard/my-view"] = EMPTY_MY_VIEW;
    routes["/dashboard/org-view"] = ORG_VIEW_WITH_REPORTS;
    renderAt("/dashboard");

    fireEvent.click(await screen.findByRole("button", { name: /Org View/ }));

    expect(await screen.findByText("Emp Person")).toBeTruthy();
    const orgViewCalls = mockFetchWithAuth.mock.calls.filter(([u]) =>
      u.endsWith("/dashboard/org-view"),
    );
    expect(orgViewCalls).toHaveLength(1);
  });
});

describe("Dashboard — view as subordinate", () => {
  it("loads the report's dashboard, names them in a read-only banner, and skips the org view", async () => {
    routes["/dashboard/team-member-view/emp"] = {
      ...EMPTY_MY_VIEW,
      targetUser: { userId: "emp", name: "Emp Person" },
    };

    renderAt("/dashboard/team/emp");

    expect(await screen.findByText(/read-only/)).toBeTruthy();
    expect(screen.getAllByText("Emp Person").length).toBeGreaterThan(0);
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/dashboard/team-member-view/emp",
    );
    const urls = mockFetchWithAuth.mock.calls.map(([u]) => u);
    expect(urls).not.toContain("/api/dashboard/org-view");
    expect(urls).not.toContain("/api/dashboard/my-view");
    expect(screen.queryByRole("button", { name: /Org View/ })).toBeNull();
  });

  it("never shows the caller's own notifications on a report's dashboard", async () => {
    routes["/dashboard/team-member-view/emp"] = {
      ...EMPTY_MY_VIEW,
      targetUser: { userId: "emp", name: "Emp Person" },
    };

    renderAt("/dashboard/team/emp");

    await screen.findByText(/read-only/);
    expect(mockListNotifications).not.toHaveBeenCalled();
    expect(screen.queryByText("Notifications")).toBeNull();
  });
});
