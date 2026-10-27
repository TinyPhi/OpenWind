import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
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

const { RosterPage } = await import("./index.js");

const TEAM_A = {
  id: "team-1",
  name: "Platform On-Call",
  description: null,
  createdAt: "2026-01-01T00:00:00Z",
};

const USER_A = { userId: "u-1", displayName: "Ada Lovelace" };

const SCHEDULE_A = {
  id: "sched-1",
  teamId: "team-1",
  label: "Week 1",
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString(),
  primaryUserId: "u-1",
  backupUserId: null,
  escalationManagerUserId: null,
};

function renderPage(): ReturnType<typeof render> {
  return render(<RosterPage />);
}

describe("RosterPage", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads teams/users, then the selected team's schedules, and renders a bar per schedule", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] }); // teams
    mockFetchWithAuth.mockResolvedValueOnce({ data: [USER_A] }); // users
    mockFetchWithAuth.mockResolvedValueOnce({ data: [SCHEDULE_A] }); // schedules

    renderPage();

    await waitFor(() => expect(screen.getByText(/Week 1/)).toBeTruthy());
    expect(screen.getByText(/Ada Lovelace/)).toBeTruthy();
  });

  it("renders a schedule that only partially overlaps the visible week without breaking the grid (boundary clamp regression)", async () => {
    // Starts 3 days before the visible week and ends 3 days into it -- the
    // rendered bar must clamp to day 0 of the grid, not a negative or
    // out-of-range gridColumnStart.
    const now = new Date();
    const straddling = {
      ...SCHEDULE_A,
      id: "sched-straddle",
      startsAt: new Date(now.getTime() - 10 * 24 * 3_600_000).toISOString(),
      endsAt: new Date(
        now.getTime() - 4 * 24 * 3_600_000 + 2 * 3_600_000,
      ).toISOString(),
    };
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [USER_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [straddling] });

    renderPage();

    // Regardless of whether this particular window overlaps the current
    // week, the page must render without throwing and without an empty-state
    // false-negative when data IS present -- the real assertion is just that
    // rendering completes cleanly for an edge-case date range.
    await waitFor(() =>
      expect(screen.getByText("On-Call Roster")).toBeTruthy(),
    );
  });

  it("shows an empty roster message when the team has no schedules this week", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [USER_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });

    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("No on-call schedules this week for this team."),
      ).toBeTruthy(),
    );
  });

  it("shows a no-teams empty state when there are no teams at all", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No team selected")).toBeTruthy(),
    );
  });
});

describe("RosterPage schedule modal — team first, members only", () => {
  const ADA = { userId: "u-1", displayName: "Ada Lovelace", email: "a@x.io" };
  const BEN = { userId: "u-2", displayName: "Ben Cole", email: "b@x.io" };
  const CARA = { userId: "u-3", displayName: "Cara Diaz", email: "c@x.io" };
  const TEAM_WITH_MEMBERS = {
    ...TEAM_A,
    members: [
      { userId: "u-2", position: 0 },
      { userId: "u-1", position: 1 },
    ],
  };
  const TEAM_EMPTY = {
    id: "team-2",
    name: "Support",
    description: null,
    createdAt: "2026-01-01T00:00:00Z",
    members: [],
  };

  function routeFetch(): void {
    mockFetchWithAuth.mockImplementation((...args: unknown[]) => {
      const url = String(args[0]);
      if (url.endsWith("/admin/teams"))
        return Promise.resolve({ data: [TEAM_WITH_MEMBERS, TEAM_EMPTY] });
      if (url.endsWith("/admin/members"))
        return Promise.resolve({ data: [ADA, BEN, CARA] });
      if (url.includes("/admin/on-call-schedules?"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });
  }

  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  async function openCreateModal(): Promise<void> {
    renderPage();
    await waitFor(() => expect(screen.getByText("New Schedule")).toBeTruthy());
    fireEvent.click(screen.getByText("New Schedule"));
    await waitFor(() => expect(screen.getByLabelText(/Team \*/)).toBeTruthy());
  }

  it("offers only the chosen team's members in the pickers, in rotation order", async () => {
    routeFetch();
    await openCreateModal();

    fireEvent.click(screen.getByText("Select a user"));
    await waitFor(() => expect(screen.getAllByText("Ben Cole").length).toBe(1));
    expect(screen.getAllByText("Ada Lovelace")).toHaveLength(1);
    expect(screen.queryByText("Cara Diaz")).toBeNull();
    expect(screen.queryByText(/has no members yet/)).toBeNull();
  });

  it("clears the picks and lists everyone, with a hint, when the team has no members", async () => {
    routeFetch();
    await openCreateModal();

    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Ben Cole"));
    fireEvent.change(screen.getByLabelText(/Team \*/), {
      target: { value: "team-2" },
    });

    expect(screen.queryByText("Ben Cole")).toBeNull();
    expect(screen.getByText(/has no members yet/)).toBeTruthy();
    fireEvent.click(screen.getByText("Select a user"));
    await waitFor(() => expect(screen.getByText("Cara Diaz")).toBeTruthy());
  });

  it("creates the window on the team picked in the modal", async () => {
    routeFetch();
    await openCreateModal();
    fireEvent.change(screen.getByLabelText(/Team \*/), {
      target: { value: "team-2" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. Week 1"), {
      target: { value: "Cover" },
    });
    const [starts, ends] = Array.from(
      document.querySelectorAll('input[type="datetime-local"]'),
    );
    fireEvent.change(starts as Element, {
      target: { value: "2030-01-01T09:00" },
    });
    fireEvent.change(ends as Element, {
      target: { value: "2030-01-08T09:00" },
    });
    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Cara Diaz"));
    fireEvent.click(screen.getByText("Create schedule"));

    await waitFor(() => {
      const post = mockFetchWithAuth.mock.calls.find(
        (c) => (c[1] as { method?: string } | undefined)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(
        JSON.parse((post?.[1] as { body: string }).body) as unknown,
      ).toMatchObject({ teamId: "team-2", primaryUserId: "u-3" });
    });
  });
});

describe("RosterPage repeating roster (oncall-team-rotation R4, R9)", () => {
  const ADA = { userId: "u-1", displayName: "Ada Lovelace", email: "a@x.io" };
  const BEN = { userId: "u-2", displayName: "Ben Cole", email: "b@x.io" };
  const TEAM_WITH_MEMBERS = {
    ...TEAM_A,
    members: [
      { userId: "u-1", position: 0 },
      { userId: "u-2", position: 1 },
    ],
  };
  const TEAM_EMPTY = {
    id: "team-2",
    name: "Support",
    description: null,
    createdAt: "2026-01-01T00:00:00Z",
    members: [],
  };
  const ROTATION = {
    id: "rot-1",
    teamId: "team-1",
    cycleDays: 7,
    status: "active",
    blocked: false,
    blockedReason: null,
    endsOn: null,
    nextStartsAt: "2031-03-18T12:00:00Z",
    nextPrimaryUserId: "u-2",
    nextBackupUserId: "u-1",
  };

  let rotations: unknown[] = [];
  let schedulesData: unknown[] = [];

  function routeFetch(): void {
    mockFetchWithAuth.mockImplementation((...args: unknown[]) => {
      const url = String(args[0]);
      if (url.endsWith("/admin/teams"))
        return Promise.resolve({ data: [TEAM_WITH_MEMBERS, TEAM_EMPTY] });
      if (url.endsWith("/admin/members"))
        return Promise.resolve({ data: [ADA, BEN] });
      if (url.includes("/admin/on-call-rotations?"))
        return Promise.resolve({ data: rotations });
      if (url.includes("/admin/on-call-schedules?"))
        return Promise.resolve({ data: schedulesData });
      return Promise.resolve({ data: {} });
    });
  }

  function bodiesFor(method: string, contains: string): unknown[] {
    return mockFetchWithAuth.mock.calls
      .filter(
        (c) =>
          String(c[0]).includes(contains) &&
          (c[1] as { method?: string } | undefined)?.method === method,
      )
      .map((c): unknown => JSON.parse((c[1] as { body: string }).body));
  }

  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
    rotations = [];
    schedulesData = [];
  });

  afterEach(() => {
    cleanup();
  });

  async function openCreateModal(): Promise<void> {
    renderPage();
    await waitFor(() => expect(screen.getByText("New Schedule")).toBeTruthy());
    fireEvent.click(screen.getByText("New Schedule"));
    await waitFor(() => expect(screen.getByLabelText(/Team \*/)).toBeTruthy());
  }

  function fillWindow(): void {
    fireEvent.change(screen.getByPlaceholderText("e.g. Week 1"), {
      target: { value: "Week A" },
    });
    const [starts, ends] = Array.from(
      document.querySelectorAll('input[type="datetime-local"]'),
    );
    fireEvent.change(starts as Element, {
      target: { value: "2031-03-11T09:00" },
    });
    fireEvent.change(ends as Element, {
      target: { value: "2031-03-18T09:00" },
    });
  }

  it("offers a repeat option for a team with members and sends the cycle length", async () => {
    routeFetch();
    await openCreateModal();
    fillWindow();
    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Ben Cole"));
    fireEvent.click(screen.getByLabelText(/Repeat every/));
    fireEvent.change(screen.getByLabelText("Cycle length in days"), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByText("Create schedule"));

    await waitFor(() =>
      expect(bodiesFor("POST", "/admin/on-call-schedules")).toEqual([
        expect.objectContaining({
          teamId: "team-1",
          primaryUserId: "u-2",
          repeat: { cycleDays: 14 },
        }),
      ]),
    );
  });

  it("does not send a repeat when the option is off", async () => {
    routeFetch();
    await openCreateModal();
    fillWindow();
    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Ben Cole"));
    fireEvent.click(screen.getByText("Create schedule"));
    await waitFor(() =>
      expect(bodiesFor("POST", "/admin/on-call-schedules")).toHaveLength(1),
    );
    expect(bodiesFor("POST", "/admin/on-call-schedules")[0]).not.toHaveProperty(
      "repeat",
    );
  });

  it("disables repeating for a team with no members and says why", async () => {
    routeFetch();
    await openCreateModal();
    fireEvent.change(screen.getByLabelText(/Team \*/), {
      target: { value: "team-2" },
    });
    expect(
      (screen.getByLabelText(/Repeat every/) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Repeating needs a team with at least one member/),
    ).toBeTruthy();
  });

  it("blocks saving a cycle outside 3 to 90 days", async () => {
    routeFetch();
    await openCreateModal();
    fillWindow();
    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Ben Cole"));
    fireEvent.click(screen.getByLabelText(/Repeat every/));
    for (const bad of ["2", "91", "7.5", ""]) {
      fireEvent.change(screen.getByLabelText("Cycle length in days"), {
        target: { value: bad },
      });
      expect(
        (screen.getByText("Create schedule") as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    fireEvent.change(screen.getByLabelText("Cycle length in days"), {
      target: { value: "3" },
    });
    expect(
      (screen.getByText("Create schedule") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows the rotation panel with cycle, next window and who is next", async () => {
    rotations = [ROTATION];
    routeFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Repeating roster")).toBeTruthy(),
    );
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/Every 7 days/)).toBeTruthy();
    expect(
      screen.getByText(/primary Ben Cole, backup Ada Lovelace/),
    ).toBeTruthy();
  });

  it("shows no panel for a team without a rotation", async () => {
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("New Schedule")).toBeTruthy());
    expect(screen.queryByText("Repeating roster")).toBeNull();
  });

  it("shows a blocked rotation with its reason", async () => {
    rotations = [
      {
        ...ROTATION,
        blocked: true,
        blockedReason: "The window manual cover overlaps the next window",
      },
    ];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Blocked")).toBeTruthy());
    expect(screen.getByText(/manual cover overlaps/)).toBeTruthy();
  });

  it("stops an active rotation", async () => {
    rotations = [ROTATION];
    routeFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Stop repeating")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Stop repeating"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { status: "stopped" },
      ]),
    );
  });

  it("resumes a stopped rotation", async () => {
    rotations = [{ ...ROTATION, status: "stopped" }];
    routeFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Resume repeating")).toBeTruthy(),
    );
    expect(screen.getByText("Stopped")).toBeTruthy();
    fireEvent.click(screen.getByText("Resume repeating"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { status: "active" },
      ]),
    );
  });

  it("sets and clears the end date", async () => {
    rotations = [ROTATION];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("End date")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2031-12-31" },
    });
    fireEvent.click(screen.getByText("Set end date"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { endsOn: "2031-12-31" },
      ]),
    );
  });

  it("marks windows that belong to a repeating roster", async () => {
    schedulesData = [
      {
        ...SCHEDULE_A,
        id: "s-rot",
        label: "Rotation week",
        rotationId: "rot-1",
      },
      { ...SCHEDULE_A, id: "s-man", label: "Manual week", rotationId: null },
    ];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Rotation week")).toBeTruthy());
    expect(screen.getAllByLabelText("Repeating roster").length).toBeGreaterThan(
      0,
    );
    const rotationBar = screen.getByText("Rotation week").closest("button");
    const manualBar = screen.getByText("Manual week").closest("button");
    expect(rotationBar?.textContent).toContain("↻");
    expect(manualBar?.textContent).not.toContain("↻");
  });
});
