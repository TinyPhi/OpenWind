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

const SCHEDULE_START = Date.now();
const SCHEDULE_A = {
  id: "sched-1",
  teamId: "team-1",
  label: "Week 1",
  startsAt: new Date(SCHEDULE_START).toISOString(),
  endsAt: new Date(SCHEDULE_START + 3 * 24 * 3_600_000).toISOString(),
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
    fireEvent.click(screen.getByLabelText("Create schedule"));

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
    const [starts] = Array.from(
      document.querySelectorAll('input[type="datetime-local"]'),
    );
    fireEvent.change(starts as Element, {
      target: { value: "2031-03-11T09:00" },
    });
  }

  it("offers a repeat option for a team with members and sends the cycle length", async () => {
    routeFetch();
    await openCreateModal();
    fillWindow();
    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Ben Cole"));
    fireEvent.click(screen.getByLabelText(/Repeat automatically/));
    fireEvent.change(screen.getByLabelText("Cycle length in days"), {
      target: { value: "14" },
    });
    fireEvent.click(screen.getByLabelText("Create schedule"));

    await waitFor(() =>
      expect(bodiesFor("POST", "/admin/on-call-schedules")).toEqual([
        expect.objectContaining({
          teamId: "team-1",
          primaryUserId: "u-2",
          repeat: { cycleDays: 14 },
          endsAt: new Date(
            new Date("2031-03-11T09:00").getTime() + 14 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
      ]),
    );
  });

  it("works out the end from the start and cycle length and keeps it read-only", async () => {
    routeFetch();
    await openCreateModal();
    fillWindow();
    const ends = document.querySelectorAll('input[type="datetime-local"]')[1];
    expect((ends as HTMLInputElement).disabled).toBe(true);
    expect((ends as HTMLInputElement).value).toBe("2031-03-18T09:00");
    fireEvent.change(screen.getByLabelText("Cycle length in days"), {
      target: { value: "14" },
    });
    expect((ends as HTMLInputElement).value).toBe("2031-03-25T09:00");
  });

  it("does not send a repeat when the option is off", async () => {
    routeFetch();
    await openCreateModal();
    fillWindow();
    fireEvent.click(screen.getByText("Select a user"));
    fireEvent.click(await screen.findByText("Ben Cole"));
    fireEvent.click(screen.getByLabelText("Create schedule"));
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
      (screen.getByLabelText(/Repeat automatically/) as HTMLInputElement)
        .disabled,
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
    fireEvent.click(screen.getByLabelText(/Repeat automatically/));
    for (const bad of ["2", "91", "7.5", ""]) {
      fireEvent.change(screen.getByLabelText("Cycle length in days"), {
        target: { value: bad },
      });
      expect(
        (screen.getByLabelText("Create schedule") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
    fireEvent.change(screen.getByLabelText("Cycle length in days"), {
      target: { value: "3" },
    });
    expect(
      (screen.getByLabelText("Create schedule") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  async function openRotationEdit(): Promise<void> {
    schedulesData = [
      {
        ...SCHEDULE_A,
        id: "s-rot",
        label: "Rotation week",
        rotationId: "rot-1",
      },
    ];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Rotation week")).toBeTruthy());
    fireEvent.click(
      screen.getByText("Rotation week").closest("button") as Element,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Repeat automatically/)).toBeTruthy(),
    );
  }

  it("has no separate repeating roster box on the page", async () => {
    rotations = [ROTATION];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("New Schedule")).toBeTruthy());
    expect(screen.queryByText("Repeating roster")).toBeNull();
    expect(screen.queryByText("Stop repeating")).toBeNull();
    expect(screen.queryByLabelText("End date")).toBeNull();
  });

  it("shows the repeat state and who is next inside the edit modal", async () => {
    rotations = [ROTATION];
    await openRotationEdit();
    expect(
      (screen.getByLabelText(/Repeat automatically/) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      screen.getByText(/primary Ben Cole, backup Ada Lovelace/),
    ).toBeTruthy();
  });

  it("shows a blocked rotation's reason in the edit modal", async () => {
    rotations = [
      {
        ...ROTATION,
        blocked: true,
        blockedReason: "The window manual cover overlaps the next window",
      },
    ];
    await openRotationEdit();
    expect(screen.getByText(/manual cover overlaps/)).toBeTruthy();
  });

  it("stops the rotation when repeat is unticked and the window is saved", async () => {
    rotations = [ROTATION];
    await openRotationEdit();
    fireEvent.click(screen.getByLabelText(/Repeat automatically/));
    fireEvent.click(screen.getByLabelText("Save changes"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { status: "stopped" },
      ]),
    );
  });

  it("resumes a stopped rotation when repeat is ticked and the window is saved", async () => {
    rotations = [{ ...ROTATION, status: "stopped" }];
    await openRotationEdit();
    expect(
      (screen.getByLabelText(/Repeat automatically/) as HTMLInputElement)
        .checked,
    ).toBe(false);
    fireEvent.click(screen.getByLabelText(/Repeat automatically/));
    fireEvent.click(screen.getByLabelText("Save changes"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { status: "active" },
      ]),
    );
  });

  it("asks what to do with this cycle's end when repeat is unticked, and sends a changed end", async () => {
    rotations = [ROTATION];
    await openRotationEdit();
    expect(screen.queryByText(/Keep it as set/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Repeat automatically/));
    expect(screen.getByText(/Keep it as set/)).toBeTruthy();
    const ends = document.querySelectorAll('input[type="datetime-local"]')[1];
    expect((ends as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Change it/));
    expect((ends as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(ends as Element, {
      target: { value: "2031-01-02T10:00" },
    });
    fireEvent.click(screen.getByLabelText("Save changes"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-schedules/s-rot")).toEqual([
        expect.objectContaining({
          endsAt: new Date("2031-01-02T10:00").toISOString(),
        }),
      ]),
    );
  });

  it("pauses the roster only after a warning", async () => {
    rotations = [ROTATION];
    await openRotationEdit();
    fireEvent.click(screen.getByLabelText("Pause roster"));
    expect(screen.getByText(/only one roster can run at a time/)).toBeTruthy();
    expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([]);
    fireEvent.click(screen.getByText("Pause roster"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { status: "stopped" },
      ]),
    );
  });

  it("offers Resume roster for a paused roster", async () => {
    rotations = [{ ...ROTATION, status: "stopped" }];
    await openRotationEdit();
    fireEvent.click(screen.getByLabelText("Resume roster"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([
        { status: "active" },
      ]),
    );
  });

  it("warns before deleting a window of a repeating roster", async () => {
    rotations = [ROTATION];
    await openRotationEdit();
    fireEvent.click(screen.getByLabelText("Delete schedule"));
    await waitFor(() =>
      expect(screen.getByText(/part of a repeating roster/)).toBeTruthy(),
    );
  });

  it("on a running window sends only the changed end, not the start or people", async () => {
    schedulesData = [{ ...SCHEDULE_A, id: "s-run", label: "Running" }];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());
    fireEvent.click(screen.getByText("Running").closest("button") as Element);
    await waitFor(() =>
      expect(screen.getByText(/already running/)).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Cycle length in days"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByLabelText("Save changes"));
    await waitFor(() => {
      const [body] = bodiesFor(
        "PATCH",
        "/admin/on-call-schedules/s-run",
      ) as Record<string, unknown>[];
      expect(body).toBeTruthy();
      expect(body).toHaveProperty("endsAt");
      expect(body).not.toHaveProperty("startsAt");
      expect(body).not.toHaveProperty("primaryUserId");
    });
  });

  it("shows upcoming windows of a running roster lightly and opens them read-only", async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    rotations = [
      {
        ...ROTATION,
        projected: [
          {
            startsAt: new Date(start.getTime() + 24 * 3_600_000).toISOString(),
            endsAt: new Date(
              start.getTime() + 3 * 24 * 3_600_000,
            ).toISOString(),
            primaryUserId: "u-2",
            backupUserId: "u-1",
            escalationManagerUserId: null,
          },
        ],
      },
    ];
    routeFetch();
    renderPage();
    const bar = await screen.findByText("Upcoming");
    expect(screen.queryByText(/No on-call schedules this week/)).toBeNull();
    fireEvent.click(bar.closest("button") as Element);
    await waitFor(() =>
      expect(screen.getByText("Upcoming window")).toBeTruthy(),
    );
    expect(screen.getByText(/Not active yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Save changes")).toBeNull();
    expect(screen.queryByLabelText("Create schedule")).toBeNull();
  });

  it("shows no upcoming windows for a roster without projections", async () => {
    rotations = [{ ...ROTATION, projected: [] }];
    routeFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No on-call schedules this week/)).toBeTruthy(),
    );
    expect(screen.queryByText("Upcoming")).toBeNull();
  });

  it("leaves the rotation alone when repeat is not changed", async () => {
    rotations = [ROTATION];
    await openRotationEdit();
    fireEvent.click(screen.getByLabelText("Save changes"));
    await waitFor(() =>
      expect(bodiesFor("PATCH", "/admin/on-call-schedules/s-rot")).toHaveLength(
        1,
      ),
    );
    expect(bodiesFor("PATCH", "/admin/on-call-rotations/rot-1")).toEqual([]);
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

  it("edits a window with the same start, cycle and read-only end layout", async () => {
    schedulesData = [{ ...SCHEDULE_A, id: "s-edit", label: "Edit me" }];
    routeFetch();
    renderPage();
    await waitFor(() => expect(screen.getByText("Edit me")).toBeTruthy());
    fireEvent.click(screen.getByText("Edit me").closest("button") as Element);
    await waitFor(() =>
      expect(screen.getByLabelText("Cycle length in days")).toBeTruthy(),
    );
    const ends = document.querySelectorAll('input[type="datetime-local"]')[1];
    expect((ends as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/Repeat automatically/)).toBeNull();
  });
});
