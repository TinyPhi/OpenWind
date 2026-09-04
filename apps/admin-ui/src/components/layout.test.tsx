import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";

// Admin-UI sidebar restructuring: workspace nav (all roles) is now visually
// separated from an admin-only "Admin" section (docs task: split the side
// menu so admin-only items are easy to tell apart at a glance).

vi.mock("@refinedev/core", () => ({
  useGetIdentity: () => ({
    data: { id: "u1", name: "Jane Doe", email: "jane@example.com" },
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
    expect(screen.getByText("Users")).not.toBeNull();
    expect(screen.getByText("System Logs")).not.toBeNull();
    expect(screen.getByText("API Keys")).not.toBeNull();
    expect(screen.getByText("API Access Logs")).not.toBeNull();
  });

  it("hides the 'Admin' section entirely for an agent (no admin role)", async () => {
    mockUserWithRoles(["agent"]);
    renderLayout();

    // Dashboard (workspace nav) still renders once roles resolve — used as
    // the "identity has loaded" signal before asserting the negative below.
    await waitFor(() => expect(screen.getByText("Dashboard")).not.toBeNull());

    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByText("Users")).toBeNull();
    expect(screen.queryByText("System Logs")).toBeNull();
    expect(screen.queryByText("API Keys")).toBeNull();
    expect(screen.queryByText("API Access Logs")).toBeNull();
  });
});
