import React, { Suspense, useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import {
  MemoryRouter,
  Routes,
  Route,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { RouteErrorBoundary } from "./components/route-error-boundary.js";

// Mock Layout tracking mount and unmount lifecycles
const layoutMountSpy = vi.fn();
const layoutUnmountSpy = vi.fn();

interface MockLayoutProps {
  children: React.ReactNode;
}

function MockLayout({ children }: MockLayoutProps): React.ReactElement {
  useEffect(() => {
    layoutMountSpy();
    return (): void => {
      layoutUnmountSpy();
    };
  }, []);

  return (
    <div data-testid="app-shell-layout">
      <header data-testid="app-header">Header with Navigation</header>
      <nav data-testid="app-sidebar">Sidebar Menu</nav>
      <main data-testid="app-main-content">{children}</main>
    </div>
  );
}

function RouteLoadingFallback(): React.ReactElement {
  return <div data-testid="route-loading-fallback">Loading…</div>;
}

function ShellOutlet(): React.ReactElement {
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary resetKey={pathname}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </Suspense>
    </RouteErrorBoundary>
  );
}

// Navigation controller for programmatic routing inside test
let navigateFn: (to: string) => void = (): void => {};

function NavigationBridge(): React.ReactElement {
  const navigate = useNavigate();
  useEffect(() => {
    navigateFn = navigate;
  }, [navigate]);
  return null as unknown as React.ReactElement;
}

describe("Shell Stability during Route Transitions and Lazy Loading", () => {
  beforeEach(() => {
    layoutMountSpy.mockClear();
    layoutUnmountSpy.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps Layout mounted across route transitions without unmounting or tearing down the shell", async () => {
    let resolvePageB: () => void = (): void => {};
    const PageBPromise = new Promise<{ default: React.ComponentType }>(
      (resolve) => {
        resolvePageB = (): void => {
          resolve({
            default: (): React.ReactElement => (
              <div data-testid="page-b">Page B Content</div>
            ),
          });
        };
      },
    );

    const LazyPageB = React.lazy(() => PageBPromise);

    function PageA(): React.ReactElement {
      return <div data-testid="page-a">Page A Content</div>;
    }

    render(
      <MemoryRouter initialEntries={["/page-a"]}>
        <NavigationBridge />
        <Routes>
          <Route
            element={
              <MockLayout>
                <ShellOutlet />
              </MockLayout>
            }
          >
            <Route path="/page-a" element={<PageA />} />
            <Route path="/page-b" element={<LazyPageB />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    // Initial render at /page-a
    expect(screen.getByTestId("app-shell-layout")).toBeDefined();
    expect(screen.getByTestId("app-header")).toBeDefined();
    expect(screen.getByTestId("app-sidebar")).toBeDefined();
    expect(screen.getByTestId("page-a")).toBeDefined();
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);
    expect(layoutUnmountSpy).toHaveBeenCalledTimes(0);

    // Navigate to lazy /page-b
    await act(async () => {
      navigateFn("/page-b");
      await Promise.resolve();
    });

    // While /page-b is loading, RouteLoadingFallback displays INSIDE outlet
    expect(screen.getByTestId("route-loading-fallback")).toBeDefined();

    // Critical shell invariant: Layout, Header, and Sidebar MUST STAY MOUNTED!
    expect(screen.getByTestId("app-shell-layout")).toBeDefined();
    expect(screen.getByTestId("app-header")).toBeDefined();
    expect(screen.getByTestId("app-sidebar")).toBeDefined();
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);
    expect(layoutUnmountSpy).toHaveBeenCalledTimes(0);

    // Resolve the lazy chunk
    await act(async () => {
      resolvePageB();
      await Promise.resolve();
    });

    // Page B content now renders
    expect(screen.getByTestId("page-b")).toBeDefined();
    expect(screen.queryByTestId("route-loading-fallback")).toBeNull();

    // Layout STILL has never unmounted
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);
    expect(layoutUnmountSpy).toHaveBeenCalledTimes(0);

    // Navigate back to /page-a
    await act(async () => {
      navigateFn("/page-a");
      await Promise.resolve();
    });

    expect(screen.getByTestId("page-a")).toBeDefined();
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);
    expect(layoutUnmountSpy).toHaveBeenCalledTimes(0);
  });

  it("retains the shell layout when a lazy chunk fails and recovers when navigating away", async () => {
    let rejectFailingChunk: (err: Error) => void = (): void => {};
    const failingPromise = new Promise<{ default: React.ComponentType }>(
      (_, reject) => {
        rejectFailingChunk = reject;
      },
    );

    const FailingLazyPage = React.lazy(() => failingPromise);

    function SafePage(): React.ReactElement {
      return <div data-testid="safe-page">Safe Page Content</div>;
    }

    render(
      <MemoryRouter initialEntries={["/safe"]}>
        <NavigationBridge />
        <Routes>
          <Route
            element={
              <MockLayout>
                <ShellOutlet />
              </MockLayout>
            }
          >
            <Route path="/safe" element={<SafePage />} />
            <Route path="/failing-chunk" element={<FailingLazyPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("safe-page")).toBeDefined();
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);

    // Navigate to failing chunk route
    await act(async () => {
      navigateFn("/failing-chunk");
      await Promise.resolve();
    });

    // Simulate chunk failure rejection
    await act(async () => {
      rejectFailingChunk(
        new Error("Failed to fetch dynamically imported module: chunk-404.js"),
      );
      await Promise.resolve();
    });

    // Error boundary caught error inside outlet; alert is displayed
    expect(screen.getByRole("alert")).toBeDefined();

    // App shell (sidebar, header) remains fully intact and mounted!
    expect(screen.getByTestId("app-shell-layout")).toBeDefined();
    expect(screen.getByTestId("app-header")).toBeDefined();
    expect(screen.getByTestId("app-sidebar")).toBeDefined();
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);
    expect(layoutUnmountSpy).toHaveBeenCalledTimes(0);

    // Navigate away from failing route back to /safe
    await act(async () => {
      navigateFn("/safe");
      await Promise.resolve();
    });

    // Error boundary resets via resetKey={pathname}, safe page renders
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("safe-page")).toBeDefined();

    // Shell never unmounted throughout the error and recovery cycle
    expect(layoutMountSpy).toHaveBeenCalledTimes(1);
    expect(layoutUnmountSpy).toHaveBeenCalledTimes(0);
  });
});
