import React from "react";
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

const { RejectPlatformAdmin } = await import("./reject-platform-admin.js");

// Stands in for EntityTypeProvider/Layout, which fire tenant requests on mount.
const tenantShellMounted = vi.fn((): void => {});
function TenantShell(): React.ReactElement {
  React.useEffect(() => {
    tenantShellMounted();
  }, []);
  return <div>Tenant dashboard</div>;
}

function renderGuard(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <Routes>
        <Route
          path="/platform-admin/dashboard"
          element={<div>Platform admin dashboard</div>}
        />
        <Route
          path="/dashboard"
          element={
            <RejectPlatformAdmin>
              <TenantShell />
            </RejectPlatformAdmin>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RejectPlatformAdmin", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends a platform_admin to the platform dashboard without mounting the tenant shell", () => {
    mockUsePermissions.mockReturnValue({
      data: ["platform_admin"],
      isLoading: false,
    });
    renderGuard();

    expect(screen.getByText("Platform admin dashboard")).toBeTruthy();
    expect(screen.queryByText("Tenant dashboard")).toBeNull();
    expect(tenantShellMounted).not.toHaveBeenCalled();
  });

  it("does not mount the tenant shell while permissions are still loading", () => {
    mockUsePermissions.mockReturnValue({ data: undefined, isLoading: true });
    renderGuard();

    expect(screen.queryByText("Tenant dashboard")).toBeNull();
    expect(tenantShellMounted).not.toHaveBeenCalled();
  });

  it("renders the tenant shell for tenant roles", () => {
    mockUsePermissions.mockReturnValue({ data: ["admin"], isLoading: false });
    renderGuard();

    expect(screen.getByText("Tenant dashboard")).toBeTruthy();
    expect(tenantShellMounted).toHaveBeenCalledTimes(1);
  });

  it("sends a platform_admin away even when the account also holds a tenant role", () => {
    mockUsePermissions.mockReturnValue({
      data: ["admin", "platform_admin"],
      isLoading: false,
    });
    renderGuard();

    expect(screen.getByText("Platform admin dashboard")).toBeTruthy();
    expect(tenantShellMounted).not.toHaveBeenCalled();
  });

  it("fails open on a malformed permissions payload: a string is not a role list, even one that contains platform_admin (#995)", () => {
    mockUsePermissions.mockReturnValue({
      // Cast: simulates a malformed payload (a string where a list is expected), which the
      // declared type rules out; a string has .includes, so a bare roles?.includes() would redirect.
      data: "platform_admin" as unknown as string[],
      isLoading: false,
    });
    renderGuard();

    expect(screen.getByText("Tenant dashboard")).toBeTruthy();
    expect(screen.queryByText("Platform admin dashboard")).toBeNull();
  });

  it("renders the tenant shell when permissions fail to load (fail-open: backend provides the real guard)", () => {
    mockUsePermissions.mockReturnValue({ data: undefined, isLoading: false });
    renderGuard();

    expect(screen.getByText("Tenant dashboard")).toBeTruthy();
    expect(tenantShellMounted).toHaveBeenCalledTimes(1);
  });
});
