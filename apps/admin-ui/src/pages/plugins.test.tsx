import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";

const mockUseList = vi.fn();
const mockFetchWithAuth = vi.fn();
const mockRefetch = vi.fn();

vi.mock("@refinedev/core", () => ({
  useList: mockUseList,
}));

vi.mock("../lib/api.js", () => ({
  fetchWithAuth: mockFetchWithAuth,
  API_URL: "/api",
}));

const { Plugins } = await import("./plugins.js");

const PLUGIN_ROWS = [
  {
    slug: "widget_plugin",
    name: "Widget Plugin",
    version: "0.1.0",
    category: "other",
    installed: true,
    status: "active",
    errorCount: 0,
  },
  {
    slug: "flaky_plugin",
    name: "Flaky Plugin",
    version: "0.2.0",
    category: "other",
    installed: true,
    status: "active",
    errorCount: 4,
  },
  {
    slug: "uninstalled_plugin",
    name: "Uninstalled Plugin",
    version: "0.1.0",
    category: "other",
    installed: false,
    status: null,
    errorCount: 0,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockUseList.mockReturnValue({
    data: { data: PLUGIN_ROWS },
    isLoading: false,
    refetch: mockRefetch,
  });
});

afterEach(() => {
  cleanup();
});

describe("Plugins page", () => {
  it("renders every catalog plugin with its status and error count", () => {
    render(<Plugins />);

    expect(screen.getByText("Widget Plugin")).toBeDefined();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("Not installed")).toBeDefined();
    expect(screen.getByText("4")).toBeDefined(); // flaky_plugin's error count
  });

  it("shows an Uninstall button only for installed, non-disabled plugins", () => {
    render(<Plugins />);

    const uninstallButtons = screen.getAllByRole("button", {
      name: "Uninstall",
    });
    // Two installed+active rows get a button; the not-installed row doesn't.
    expect(uninstallButtons).toHaveLength(2);
  });

  it("calls the uninstall endpoint and refetches on success", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { slug: "widget_plugin" },
    });
    render(<Plugins />);

    const buttons = screen.getAllByRole("button", { name: "Uninstall" });
    const firstUninstallButton = buttons[0];
    if (!firstUninstallButton) throw new Error("expected an Uninstall button");
    fireEvent.click(firstUninstallButton);

    await waitFor(() => expect(mockRefetch).toHaveBeenCalledTimes(1));
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/plugins/widget_plugin/uninstall",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows the error message and does not refetch when uninstall fails", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("plugin is in use"));
    render(<Plugins />);

    const buttons = screen.getAllByRole("button", { name: "Uninstall" });
    const firstUninstallButton = buttons[0];
    if (!firstUninstallButton) throw new Error("expected an Uninstall button");
    fireEvent.click(firstUninstallButton);

    await waitFor(() =>
      expect(screen.getByText("⚠ plugin is in use")).toBeDefined(),
    );
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it("shows a loading state while the list is loading", () => {
    mockUseList.mockReturnValue({
      data: undefined,
      isLoading: true,
      refetch: mockRefetch,
    });
    render(<Plugins />);
    expect(screen.getByText("Loading plugins…")).toBeDefined();
  });
});
