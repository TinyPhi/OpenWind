import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("../lib/api.js", () => ({
  fetchWithAuth: vi.fn(),
  API_URL: "/api",
}));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { clearCoverageCache } = await import("../lib/oncall-coverage.js");
const { CoverageGapBadge } = await import("./coverage-gap-badge.js");

const BADGE = "No on-call coverage";

// Lets the lookup's response be handled and its state applied before an absence
// is asserted, so "shows nothing" cannot pass just because it ran too early.
const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function schedule(
  gapTeams: string[],
  coveredTeams: string[] = [],
): Promise<unknown> {
  return Promise.resolve({
    data: [
      ...gapTeams.map((teamId) => ({ teamId, teamName: teamId, oncall: null })),
      ...coveredTeams.map((teamId) => ({
        teamId,
        teamName: teamId,
        oncall: { scheduleId: "s-1" },
      })),
    ],
  });
}

describe("CoverageGapBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCoverageCache();
  });
  afterEach(() => {
    cleanup();
  });

  it("shows the badge for an unassigned ticket whose team has no active schedule", async () => {
    fetchWithAuth.mockReturnValue(schedule(["team-a"]));

    render(<CoverageGapBadge teamId="team-a" assignedTo={null} enabled />);

    const badge = await screen.findByText(BADGE);
    expect(badge.getAttribute("role")).toBe("status");
    expect(badge.getAttribute("title")).toMatch(/no on-call schedule/i);
  });

  it("shows nothing while the lookup is still pending", () => {
    fetchWithAuth.mockReturnValue(new Promise(() => undefined));

    render(<CoverageGapBadge teamId="team-a" assignedTo={null} enabled />);

    expect(screen.queryByText(BADGE)).toBeNull();
  });

  it("shows nothing when the team has an active schedule", async () => {
    fetchWithAuth.mockReturnValue(schedule(["team-other"], ["team-a"]));

    render(<CoverageGapBadge teamId="team-a" assignedTo={null} enabled />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(BADGE)).toBeNull();
  });

  it("shows nothing for a team the endpoint does not list", async () => {
    fetchWithAuth.mockReturnValue(schedule(["team-other"]));

    render(<CoverageGapBadge teamId="team-a" assignedTo={null} enabled />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(BADGE)).toBeNull();
  });

  it("shows nothing, and makes no request, once the ticket has an assignee", () => {
    fetchWithAuth.mockReturnValue(schedule(["team-a"]));

    render(<CoverageGapBadge teamId="team-a" assignedTo="u-1" enabled />);

    expect(screen.queryByText(BADGE)).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("shows nothing, and makes no request, for a ticket with no team", () => {
    render(<CoverageGapBadge teamId={null} assignedTo={null} enabled />);

    expect(screen.queryByText(BADGE)).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("shows nothing, and makes no request, when the viewer is not staff", () => {
    fetchWithAuth.mockReturnValue(schedule(["team-a"]));

    render(
      <CoverageGapBadge teamId="team-a" assignedTo={null} enabled={false} />,
    );

    expect(screen.queryByText(BADGE)).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("shows nothing when the lookup fails", async () => {
    fetchWithAuth.mockRejectedValue(new Error("403"));

    render(<CoverageGapBadge teamId="team-a" assignedTo={null} enabled />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(BADGE)).toBeNull();
  });
});
