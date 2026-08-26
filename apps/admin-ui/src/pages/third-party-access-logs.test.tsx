import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const mockFetchWithAuth = vi.fn((_url: string) =>
  Promise.resolve({ data: [] as unknown[], nextCursor: null as string | null }),
);
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { ThirdPartyAccessLogsPage } =
  await import("./third-party-access-logs.js");

describe("ThirdPartyAccessLogsPage", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
  });

  it("renders rows including one denied outcome and the residual-risk caveat", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [
        {
          id: "log-1",
          timestamp: "2026-08-25T10:00:00.000Z",
          applicationName: "Acme Sync",
          applicationKeyId: "11111111-1111-4111-1111-111111111111",
          actingPersonId: "person-a",
          ticketId: "22222222-2222-4222-2222-222222222222",
          action: "comment.created",
          outcome: "allowed",
        },
        {
          id: "log-2",
          timestamp: "2026-08-25T10:05:00.000Z",
          applicationName: "Acme Sync",
          applicationKeyId: "11111111-1111-4111-1111-111111111111",
          actingPersonId: "person-b",
          ticketId: "33333333-3333-4333-3333-333333333333",
          action: "transition.access_denied",
          outcome: "denied",
        },
      ],
      nextCursor: null,
    });

    render(<ThirdPartyAccessLogsPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Acme Sync").length).toBe(2);
    });
    expect(screen.getByText("person-a")).toBeTruthy();
    expect(screen.getByText("person-b")).toBeTruthy();
    expect(screen.getByText(/known residual risk/i)).toBeTruthy();
  });

  it("renders an anonymized/placeholder row without erroring (spec R6)", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [
        {
          id: "log-anon",
          timestamp: "2026-08-25T10:10:00.000Z",
          applicationName: null,
          applicationKeyId: "44444444-4444-4444-4444-444444444444",
          actingPersonId: null,
          ticketId: "55555555-5555-4555-5555-555555555555",
          action: "comment.created",
          outcome: "allowed",
        },
      ],
      nextCursor: null,
    });

    render(<ThirdPartyAccessLogsPage />);

    await waitFor(() => {
      expect(screen.getByText("(unknown application)")).toBeTruthy();
    });
    // actingPersonId null renders as an em dash placeholder, not a crash.
    expect(screen.getByText("—")).toBeTruthy();
  });

  // PR #489 review, F-03 -- loadMore() previously read the live (dirty)
  // filter-editing state instead of the last-applied one, silently mixing
  // an unapplied edit into the pagination request.
  it("loadMore() uses the last-applied filters, not an unapplied in-progress edit", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [
        {
          id: "log-1",
          timestamp: "2026-08-25T10:00:00.000Z",
          applicationName: "Acme Sync",
          applicationKeyId: "11111111-1111-4111-1111-111111111111",
          actingPersonId: "person-a",
          ticketId: "22222222-2222-4222-2222-222222222222",
          action: "comment.created",
          outcome: "allowed",
        },
      ],
      nextCursor: "cursor-1",
    });

    render(<ThirdPartyAccessLogsPage />);
    await waitFor(() => {
      expect(screen.getByText("Load more")).toBeTruthy();
    });

    // Edit the Application field WITHOUT clicking "Apply filters".
    fireEvent.change(screen.getByPlaceholderText("api key uuid"), {
      target: { value: "unapplied-key-id" },
    });

    mockFetchWithAuth.mockResolvedValueOnce({ data: [], nextCursor: null });
    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
    });
    const loadMoreUrl = mockFetchWithAuth.mock.calls[1]?.[0] as string;
    expect(loadMoreUrl).toContain("cursor=cursor-1");
    expect(loadMoreUrl).not.toContain("unapplied-key-id");
  });

  it("shows the empty state when no rows match", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [], nextCursor: null });

    render(<ThirdPartyAccessLogsPage />);

    await waitFor(() => {
      expect(screen.getByText("No matching requests")).toBeTruthy();
    });
  });
});
