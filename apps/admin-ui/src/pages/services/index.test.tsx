import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const mockFetchWithAuth = vi.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(null),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockShowAlert = vi.fn((_message: string): void => undefined);
vi.mock("../../components/global-alert-dialog.js", () => ({
  showAlert: (message: string) => mockShowAlert(message),
}));

const { ServicesPage } = await import("./index.js");

const TEAM_A = {
  id: "team-1",
  name: "Platform On-Call",
  description: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const SERVICE_A = {
  id: "svc-1",
  name: "Payments API",
  description: "Handles payments",
  teamId: "team-1",
  createdAt: "2026-01-01T00:00:00Z",
};

function renderPage(): ReturnType<typeof render> {
  return render(<ServicesPage />);
}

describe("ServicesPage", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the service list with its resolved team name", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [SERVICE_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    renderPage();

    await waitFor(() => expect(screen.getByText("Payments API")).toBeTruthy());
    expect(screen.getByText("Platform On-Call")).toBeTruthy();
  });

  it("shows an empty state when there are no services", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No services yet")).toBeTruthy(),
    );
  });

  it("opens the create modal and posts a new service", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No services yet")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("New Service"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Payments API"), {
      target: { value: "Billing API" },
    });

    mockFetchWithAuth.mockResolvedValueOnce({ data: SERVICE_A });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [SERVICE_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    fireEvent.click(screen.getByText("Create service"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/admin/services",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
