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

const mockUsePermissions = vi.fn(
  (): { data: string[] | undefined; isLoading: boolean } => ({
    data: undefined,
    isLoading: false,
  }),
);
vi.mock("@refinedev/core", () => ({
  usePermissions: () => mockUsePermissions(),
}));

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

const signinRedirect = vi.fn(
  (_opts: { prompt: string }): Promise<void> => Promise.resolve(),
);
vi.mock("../../authProvider.js", () => ({
  userManager: {
    signinRedirect: (opts: { prompt: string }) => signinRedirect(opts),
  },
}));

const { PlatformAdminLogin } = await import("./login.js");

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <PlatformAdminLogin />
    </MemoryRouter>,
  );
}

describe("PlatformAdminLogin", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a sign-in button when not authenticated", () => {
    mockUsePermissions.mockReturnValue({ data: undefined, isLoading: false });
    renderPage();

    expect(screen.getByText("Sign in")).toBeTruthy();
  });

  it("triggers the OIDC redirect when sign-in is clicked", async () => {
    mockUsePermissions.mockReturnValue({ data: undefined, isLoading: false });
    signinRedirect.mockResolvedValue(undefined);
    renderPage();

    fireEvent.click(screen.getByText("Sign in"));

    await waitFor(() => {
      expect(signinRedirect).toHaveBeenCalledWith({ prompt: "login" });
    });
  });

  it("shows an inline error when the redirect itself fails", async () => {
    mockUsePermissions.mockReturnValue({ data: undefined, isLoading: false });
    signinRedirect.mockRejectedValue(new Error("IdP unreachable"));
    renderPage();

    fireEvent.click(screen.getByText("Sign in"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });

  it("shows a not-authorized message when authenticated without the platform_admin role", () => {
    mockUsePermissions.mockReturnValue({ data: ["admin"], isLoading: false });
    renderPage();

    expect(screen.getByText("Not authorized")).toBeTruthy();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("navigates to the dashboard when authenticated with the platform_admin role", async () => {
    mockUsePermissions.mockReturnValue({
      data: ["platform_admin"],
      isLoading: false,
    });
    renderPage();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith("/platform-admin/dashboard", {
        replace: true,
      });
    });
  });
});
