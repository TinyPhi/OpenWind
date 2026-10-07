import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";

// Admin-UI sidebar restructuring: workspace nav (all roles) is now visually
// separated from an admin-only "Admin" section (docs task: split the side
// menu so admin-only items are easy to tell apart at a glance).

let mockIdentityData: {
  id: string;
  name: string;
  email: string;
  avatar?: string;
} = {
  id: "u1",
  name: "Jane Doe",
  email: "jane@example.com",
};

vi.mock("@refinedev/core", () => ({
  useGetIdentity: () => ({
    data: mockIdentityData,
  }),
  useLogout: () => ({ mutate: vi.fn() }),
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("./notification-bell.js", () => ({
  NotificationBell: () => null,
}));

const mockGetUser = vi.fn(
  (): Promise<{ profile: Record<string, unknown> }> =>
    Promise.resolve({ profile: {} }),
);
vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: () => mockGetUser(),
    events: { addUserLoaded: vi.fn(), removeUserLoaded: vi.fn() },
  },
}));

const { Layout } = await import("./layout.js");

function renderLayout(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Layout>
        <div>content</div>
      </Layout>
    </MemoryRouter>,
  );
}

function mockUserWithRoles(roles: string[]): void {
  const rolesMap = Object.fromEntries(roles.map((r) => [r, {}]));
  mockGetUser.mockResolvedValue({
    profile: { "urn:zitadel:iam:org:project:roles": rolesMap },
  });
}

describe("Layout sidebar — workspace vs admin-only sections", () => {
  afterEach(() => cleanup());

  it("shows an 'Admin' section label and the admin-only nav items for an admin", async () => {
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() => expect(screen.getByText("Admin")).not.toBeNull());
    expect(screen.getByText("Analytics")).not.toBeNull();
    expect(screen.getByText("Templates")).not.toBeNull();
    expect(screen.getByText("Automations")).not.toBeNull();
    expect(screen.getByText("System Logs")).not.toBeNull();
    expect(screen.getByText("API Keys")).not.toBeNull();
    expect(screen.getByText("On-Call")).not.toBeNull();
    // 2026-09-22 nav reorganization: no separate top-level "API Access
    // Logs" entry anymore -- that content already lives in the API Keys
    // page's own tab.
    expect(screen.queryByText("API Access Logs")).toBeNull();
  });

  // 2026-09-22 nav reorganization: Dashboard/Workflows/Records/Users are the
  // normal workspace nav, shown to agent and admin alike -- only Analytics/
  // Templates/Automations/System Logs/API Keys/On-Call/Schedule Rules are
  // admin-only now.
  it("hides the 'Admin' section and its admin-only items for an agent, but still shows the normal workspace nav including Users", async () => {
    mockUserWithRoles(["agent"]);
    renderLayout();

    await waitFor(() => expect(screen.getByText("Dashboard")).not.toBeNull());
    expect(screen.getByText("Workflows")).not.toBeNull();
    expect(screen.getByText("Records")).not.toBeNull();
    expect(screen.getByText("Users")).not.toBeNull();

    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByText("Analytics")).toBeNull();
    expect(screen.queryByText("Templates")).toBeNull();
    expect(screen.queryByText("Automations")).toBeNull();
    expect(screen.queryByText("System Logs")).toBeNull();
    expect(screen.queryByText("API Keys")).toBeNull();
    expect(screen.queryByText("On-Call")).toBeNull();
  });

  it("renders InitialsAvatar with role='img' and accessible aria-label", () => {
    mockIdentityData = {
      id: "u1",
      name: "Jane Doe",
      email: "jane@example.com",
    };
    mockUserWithRoles(["agent"]);
    renderLayout();

    const avatarElements = screen.getAllByRole("img", {
      name: "Jane Doe avatar",
    });
    expect(avatarElements.length).toBeGreaterThan(0);
  });

  it("renders image avatar with alt={name || 'Avatar'} when avatar URL is provided", () => {
    mockIdentityData = {
      id: "u1",
      name: "Jane Doe",
      email: "jane@example.com",
      avatar: "https://example.com/jane.png",
    };
    mockUserWithRoles(["agent"]);
    renderLayout();

    const avatarImages = screen.getAllByAltText("Jane Doe");
    expect(avatarImages.length).toBeGreaterThan(0);
  });

  describe("initials derivation", () => {
    const initialsFor = (name: string): string => {
      mockIdentityData = { id: "u1", name, email: "u@example.com" };
      mockUserWithRoles(["agent"]);
      renderLayout();
      const avatar = screen
        .getAllByRole("img")
        .find((el) => el.getAttribute("aria-label")?.endsWith(" avatar"));
      return avatar?.textContent ?? "";
    };

    it.each([
      ["Jane Doe", "JD"],
      ["John  Doe", "JD"],
      ["  John Doe  ", "JD"],
      ["madonna", "M"],
      ["Mary Jane Watson", "MJ"],
      ["", "U"],
      ["   ", "U"],
    ])("derives initials for %j as %s", (name, expected) => {
      expect(initialsFor(name)).toBe(expected);
    });
  });
});
