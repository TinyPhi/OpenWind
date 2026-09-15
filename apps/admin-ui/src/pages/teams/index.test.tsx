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

const { TeamsPage } = await import("./index.js");

const TEAM_A = {
  id: "team-1",
  name: "Platform On-Call",
  description: "Handles platform incidents",
  createdAt: "2026-01-01T00:00:00Z",
};

function renderPage(): ReturnType<typeof render> {
  return render(<TeamsPage />);
}

describe("TeamsPage", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the team list once loaded", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Platform On-Call")).toBeTruthy(),
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith("/api/admin/teams");
  });

  it("shows an empty state when there are no teams", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();

    await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());
  });

  it("opens the create modal and posts a new team", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());

    fireEvent.click(screen.getByText("New Team"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Platform On-Call"), {
      target: { value: "Support Team" },
    });

    mockFetchWithAuth.mockResolvedValueOnce({ data: TEAM_A });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    fireEvent.click(screen.getByText("Create team"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/admin/teams",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows an alert when loading fails", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("network error"));
    renderPage();

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith("Failed to load teams."),
    );
  });
});
