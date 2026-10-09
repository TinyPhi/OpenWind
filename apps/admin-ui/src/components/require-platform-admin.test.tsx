import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const mockUsePermissions = vi.fn(
  (): { data: string[] | undefined; isLoading: boolean } => ({
    data: undefined,
    isLoading: false,
  }),
);
vi.mock("@refinedev/core", () => ({
  usePermissions: () => mockUsePermissions(),
}));

const { RequirePlatformAdmin } = await import("./require-platform-admin.js");

function renderGuard(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/platform-admin/dashboard"]}>
      <Routes>
        <Route path="/platform-admin/login" element={<div>Login page</div>} />
        <Route element={<RequirePlatformAdmin />}>
          <Route
            path="/platform-admin/dashboard"
            element={<div>Dashboard content</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequirePlatformAdmin", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders nothing while permissions are loading", () => {
    mockUsePermissions.mockReturnValue({ data: undefined, isLoading: true });
    renderGuard();

    expect(screen.queryByText("Dashboard content")).toBeNull();
    expect(screen.queryByText("Login page")).toBeNull();
  });

  it("redirects to /platform-admin/login when the platform_admin role is absent", () => {
    mockUsePermissions.mockReturnValue({ data: ["admin"], isLoading: false });
    renderGuard();

    expect(screen.getByText("Login page")).toBeTruthy();
  });

  it("redirects to /platform-admin/login when not authenticated at all (no roles)", () => {
    mockUsePermissions.mockReturnValue({ data: [], isLoading: false });
    renderGuard();

    expect(screen.getByText("Login page")).toBeTruthy();
  });

  it("renders the protected content when the platform_admin role is present", () => {
    mockUsePermissions.mockReturnValue({
      data: ["platform_admin"],
      isLoading: false,
    });
    renderGuard();

    expect(screen.getByText("Dashboard content")).toBeTruthy();
  });
});
