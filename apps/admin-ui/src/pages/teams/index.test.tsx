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

const USERS = [
  { userId: "u-1", displayName: "Asha Rao", email: "asha@example.com" },
  { userId: "u-2", displayName: "Ben Cole", email: "ben@example.com" },
  { userId: "u-3", displayName: "Chen Wu", email: "chen@example.com" },
];

const TEAM_WITH_MEMBERS = {
  ...TEAM_A,
  members: [
    { userId: "u-2", position: 0 },
    { userId: "u-1", position: 1 },
  ],
};

function routeFetch(teams: unknown[]): void {
  mockFetchWithAuth.mockImplementation((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.endsWith("/admin/members")) return Promise.resolve({ data: USERS });
    if (url.endsWith("/admin/teams")) {
      const init = args[1] as { method?: string } | undefined;
      return Promise.resolve(init?.method ? { data: {} } : { data: teams });
    }
    return Promise.resolve({ data: {} });
  });
}

function bodiesFor(method: string, suffix: string): unknown[] {
  return mockFetchWithAuth.mock.calls
    .filter(
      (c) =>
        String(c[0]).endsWith(suffix) &&
        (c[1] as { method?: string } | undefined)?.method === method,
    )
    .map((c): unknown => JSON.parse((c[1] as { body: string }).body));
}

describe("TeamsPage members", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("lists each team's members by name in rotation order", async () => {
    routeFetch([TEAM_WITH_MEMBERS]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("1. Ben Cole, 2. Asha Rao")).toBeTruthy(),
    );
  });

  it("offers only people who are not on another team", async () => {
    routeFetch([TEAM_WITH_MEMBERS]); // Ben and Asha are on Platform On-Call
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Platform On-Call")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("New Team"));
    await waitFor(() =>
      expect(screen.getByLabelText("Add member")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Add member"));
    expect(screen.getByLabelText("Chen Wu")).toBeTruthy();
    expect(screen.queryByLabelText("Ben Cole")).toBeNull();
    expect(screen.queryByLabelText("Asha Rao")).toBeNull();
  });

  it("keeps a team's own members in the picker when editing it", async () => {
    routeFetch([TEAM_WITH_MEMBERS]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Platform On-Call")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Edit team"));
    await waitFor(() =>
      expect(screen.getByLabelText("Add member")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Add member"));
    expect(screen.getByLabelText("Ben Cole")).toBeTruthy();
    expect(screen.getByLabelText("Chen Wu")).toBeTruthy();
  });

  it("creates a team with the chosen members in the chosen order", async () => {
    routeFetch([]);
    renderPage();
    await waitFor(() => expect(screen.getByText("No teams yet")).toBeTruthy());

    fireEvent.click(screen.getByText("New Team"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Platform On-Call"), {
      target: { value: "Support" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Add member")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Add member"));
    fireEvent.click(screen.getByLabelText("Asha Rao"));
    fireEvent.click(screen.getByLabelText("Chen Wu"));
    fireEvent.click(screen.getByLabelText("Move Chen Wu up"));
    fireEvent.click(screen.getByText("Create team"));

    await waitFor(() =>
      expect(bodiesFor("POST", "/admin/teams")).toEqual([
        { name: "Support", memberUserIds: ["u-3", "u-1"] },
      ]),
    );
  });

  it("saves a reordered and trimmed member list of an existing team", async () => {
    routeFetch([TEAM_WITH_MEMBERS]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Platform On-Call")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Edit team"));
    await waitFor(() =>
      expect(screen.getByLabelText("Move Ben Cole down")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Move Ben Cole down"));
    fireEvent.click(screen.getByLabelText("Add member"));
    fireEvent.click(screen.getByLabelText("Chen Wu"));
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(bodiesFor("PUT", "/admin/teams/team-1/members")).toEqual([
        { memberUserIds: ["u-1", "u-2", "u-3"] },
      ]),
    );
  });

  it("removes a member and saves the shorter list", async () => {
    routeFetch([TEAM_WITH_MEMBERS]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Platform On-Call")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Edit team"));
    await waitFor(() =>
      expect(screen.getByLabelText("Remove Ben Cole")).toBeTruthy(),
    );
    fireEvent.click(screen.getByLabelText("Remove Ben Cole"));
    expect(screen.queryByLabelText("Remove Ben Cole")).toBeNull();
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() =>
      expect(bodiesFor("PUT", "/admin/teams/team-1/members")).toEqual([
        { memberUserIds: ["u-1"] },
      ]),
    );
  });

  it("does not call the members endpoint when only the name changes", async () => {
    routeFetch([TEAM_WITH_MEMBERS]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Platform On-Call")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Edit team"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Platform On-Call"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/teams/team-1")).toHaveLength(1),
    );
    expect(bodiesFor("PUT", "/admin/teams/team-1/members")).toEqual([]);
  });
});
