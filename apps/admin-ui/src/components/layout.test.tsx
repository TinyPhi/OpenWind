import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
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

const mockFetchWithAuth = vi.fn(
  (_url: string): Promise<unknown> => Promise.resolve({ data: null }),
);
vi.mock("../lib/api.js", () => ({
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
  API_URL: "/api",
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

  it.each(["", "   "])(
    "labels the avatar 'User avatar' when the name is %j",
    (name) => {
      mockIdentityData = { id: "u1", name, email: "u@example.com" };
      mockUserWithRoles(["agent"]);
      renderLayout();

      expect(
        screen.getAllByRole("img", { name: "User avatar" }).length,
      ).toBeGreaterThan(0);
    },
  );

  it("renders an image avatar with the user's name when a URL is provided", () => {
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

  it.each(["", "   "])(
    "uses fallback alt text for an image avatar when the name is %j",
    (name) => {
      mockIdentityData = {
        id: "u1",
        name,
        email: "u@example.com",
        avatar: "https://example.com/avatar.png",
      };
      mockUserWithRoles(["agent"]);
      renderLayout();

      expect(screen.getAllByAltText("Avatar").length).toBeGreaterThan(0);
    },
  );

  it("falls back to initials when an avatar image fails to load", () => {
    mockIdentityData = {
      id: "u1",
      name: "Jane Doe",
      email: "jane@example.com",
      avatar: "https://example.com/broken.png",
    };
    mockUserWithRoles(["agent"]);
    renderLayout();

    for (const avatarImage of screen.getAllByAltText("Jane Doe")) {
      fireEvent.error(avatarImage);
    }

    const fallbacks = screen.getAllByRole("img", {
      name: "Jane Doe avatar",
    });
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.every((avatar) => avatar.textContent === "JD")).toBe(true);
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

describe("Layout header brand (R12)", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockFetchWithAuth.mockResolvedValue({ data: null });
  });

  function header(): HTMLElement {
    return document.querySelector(".main-header") as HTMLElement;
  }

  it("asks for the caller's own org brand", async () => {
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/me/org"),
    );
  });

  it("shows a sandbox's logo and name in place of the OpenWind brand", async () => {
    mockFetchWithAuth.mockResolvedValue({
      data: { name: "Acme Demo", logo: "data:image/png;base64,AAAA" },
    });
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() => expect(header().textContent).toContain("Acme Demo"));
    expect(header().textContent).not.toContain("OpenWind");
    expect(
      header().querySelector('img[src="data:image/png;base64,AAAA"]'),
    ).not.toBeNull();
    expect(header().querySelector('img[src="/favicon.svg"]')).toBeNull();
  });

  it("shows the initials of the org name when the sandbox has no logo", async () => {
    mockFetchWithAuth.mockResolvedValue({
      data: { name: "Acme Demo", logo: null },
    });
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() => expect(header().textContent).toContain("Acme Demo"));
    expect(header().textContent).toContain("AD");
    expect(header().querySelector("img")).toBeNull();
  });

  it("falls back to the initials tile when the logo image fails to load", async () => {
    mockFetchWithAuth.mockResolvedValue({
      data: { name: "Acme Demo", logo: "data:image/png;base64,AAAA" },
    });
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() =>
      expect(header().querySelector('img[src^="data:image"]')).not.toBeNull(),
    );
    fireEvent.error(
      header().querySelector('img[src^="data:image"]') as Element,
    );

    expect(header().querySelector('img[src^="data:image"]')).toBeNull();
    expect(header().textContent).toContain("AD");
  });

  it("keeps the OpenWind brand for a tenant that is not a sandbox", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: null });
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() =>
      expect(
        (header().querySelector(".logo-text") as HTMLElement).style.visibility,
      ).toBe(""),
    );
    expect(header().textContent).toContain("OpenWind");
    expect(header().querySelector('img[src="/favicon.svg"]')).not.toBeNull();
  });

  it("keeps the OpenWind brand when the lookup fails, so the app stays usable", async () => {
    mockFetchWithAuth.mockRejectedValue(new Error("Network error"));
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() =>
      expect(
        (header().querySelector(".logo-text") as HTMLElement).style.visibility,
      ).toBe(""),
    );
    expect(header().textContent).toContain("OpenWind");
  });

  it("holds the space invisibly while loading, so a sandbox never flashes OpenWind", async () => {
    let resolve!: (value: unknown) => void;
    mockFetchWithAuth.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    mockUserWithRoles(["admin"]);
    renderLayout();

    const text = header().querySelector(".logo-text") as HTMLElement;
    expect(text.style.visibility).toBe("hidden");
    expect(
      (header().querySelector('img[src="/favicon.svg"]') as HTMLElement).style
        .visibility,
    ).toBe("hidden");

    resolve({ data: { name: "Acme Demo", logo: null } });
    await waitFor(() => expect(header().textContent).toContain("Acme Demo"));
    expect(header().textContent).not.toContain("OpenWind");
  });

  it("ignores a malformed response and keeps the OpenWind brand", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: { name: 42, logo: "x" } });
    mockUserWithRoles(["admin"]);
    renderLayout();

    await waitFor(() =>
      expect(
        (header().querySelector(".logo-text") as HTMLElement).style.visibility,
      ).toBe(""),
    );
    expect(header().textContent).toContain("OpenWind");
  });
});
