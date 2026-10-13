import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

vi.mock("./api.js", () => ({
  fetchWithAuth: vi.fn(),
  API_URL: "/api",
}));

const api = await import("./api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const {
  fetchCoverageGapTeams,
  clearCoverageCache,
  useTeamCoverageGap,
  ONCALL_COVERAGE_TTL_MS,
} = await import("./oncall-coverage.js");
const { emitSessionEnd } = await import("./session-events.js");

const CURRENT_URL = "/api/admin/on-call-schedules/current";

const covered = (teamId: string) => ({
  teamId,
  teamName: teamId,
  oncall: { scheduleId: "s-1", primary: {}, backup: {}, escalationManager: {} },
});
const gap = (teamId: string) => ({ teamId, teamName: teamId, oncall: null });

describe("fetchCoverageGapTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCoverageCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only the teams with no active schedule", async () => {
    fetchWithAuth.mockResolvedValue({
      data: [gap("team-a"), covered("team-b"), gap("team-c")],
    });

    const gaps = await fetchCoverageGapTeams();

    expect(fetchWithAuth).toHaveBeenCalledWith(CURRENT_URL);
    expect([...gaps].sort()).toEqual(["team-a", "team-c"]);
  });

  it("does not treat a malformed row as a gap", async () => {
    fetchWithAuth.mockResolvedValue({
      data: [
        { teamId: "no-oncall-key" },
        { teamId: "undefined-oncall", oncall: undefined },
        { teamId: 42, oncall: null },
        { oncall: null },
        null,
        gap("real-gap"),
      ].filter((r) => r !== null),
    });

    expect([...(await fetchCoverageGapTeams())]).toEqual(["real-gap"]);
  });

  it("returns an empty set when the payload has no data array", async () => {
    fetchWithAuth.mockResolvedValue({});

    expect((await fetchCoverageGapTeams()).size).toBe(0);
  });

  it("collapses concurrent callers into one request", async () => {
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });

    await Promise.all([
      fetchCoverageGapTeams(),
      fetchCoverageGapTeams(),
      fetchCoverageGapTeams(),
    ]);

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it("serves the cache within the TTL and refetches once it expires", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });

    await fetchCoverageGapTeams();
    now += ONCALL_COVERAGE_TTL_MS - 1;
    await fetchCoverageGapTeams();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);

    now += 1;
    await fetchCoverageGapTeams();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("rejects when the request fails, does not cache the failure, and retries on the next call", async () => {
    fetchWithAuth.mockRejectedValueOnce(new Error("503"));
    await expect(fetchCoverageGapTeams()).rejects.toThrow("503");

    fetchWithAuth.mockResolvedValueOnce({ data: [gap("team-a")] });
    expect([...(await fetchCoverageGapTeams())]).toEqual(["team-a"]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("drops the cache when the session ends", async () => {
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });
    await fetchCoverageGapTeams();

    emitSessionEnd();
    await fetchCoverageGapTeams();

    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it("does not let a request started before a clear repopulate the cache", async () => {
    let resolveOld: (v: unknown) => void = () => undefined;
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const stale = fetchCoverageGapTeams();

    clearCoverageCache();
    resolveOld({ data: [gap("previous-tenant-team")] });
    await stale;

    fetchWithAuth.mockResolvedValueOnce({ data: [gap("team-now")] });
    expect([...(await fetchCoverageGapTeams())]).toEqual(["team-now"]);
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });
});

describe("useTeamCoverageGap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCoverageCache();
  });
  afterEach(() => {
    cleanup();
  });

  it("is true for a team with no active schedule", async () => {
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });

    const { result } = renderHook(() => useTeamCoverageGap("team-a", true));

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is false for a covered team", async () => {
    fetchWithAuth.mockResolvedValue({
      data: [gap("team-a"), covered("team-b")],
    });

    const { result } = renderHook(() => useTeamCoverageGap("team-b", true));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("is false, and makes no request, when not enabled", async () => {
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });

    const { result } = renderHook(() => useTeamCoverageGap("team-a", false));

    expect(result.current).toBe(false);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("is false, and makes no request, without a team id", async () => {
    const { result } = renderHook(() => useTeamCoverageGap(null, true));

    expect(result.current).toBe(false);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("is false when the lookup fails", async () => {
    fetchWithAuth.mockRejectedValue(new Error("403"));

    const { result } = renderHook(() => useTeamCoverageGap("team-a", true));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("answers on the very first render from a fresh cache, without a second request", async () => {
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });
    await fetchCoverageGapTeams();
    fetchWithAuth.mockClear();

    // renderHook reports the value after effects have run, so record each render's
    // own value to see what the first paint would show.
    const seen: boolean[] = [];
    renderHook(() => {
      const value = useTeamCoverageGap("team-a", true);
      seen.push(value);
      return value;
    });

    expect(seen[0]).toBe(true);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("drops a set older than the TTL while the refetch is out, instead of showing it", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fetchWithAuth.mockResolvedValue({ data: [gap("team-a")] });
    const { result, rerender } = renderHook(
      ({ team }: { team: string | null }) => useTeamCoverageGap(team, true),
      { initialProps: { team: "team-a" as string | null } },
    );
    await waitFor(() => expect(result.current).toBe(true));

    // The ticket becomes assigned (no team passed), the cache goes stale, then it
    // is unassigned again; the refetch is still pending.
    rerender({ team: null });
    now += ONCALL_COVERAGE_TTL_MS + 1;
    let resolveRefetch: (v: unknown) => void = () => undefined;
    fetchWithAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      }),
    );
    rerender({ team: "team-a" });

    expect(result.current).toBe(false);

    resolveRefetch({ data: [gap("team-a")] });
    await waitFor(() => expect(result.current).toBe(true));
  });
});
