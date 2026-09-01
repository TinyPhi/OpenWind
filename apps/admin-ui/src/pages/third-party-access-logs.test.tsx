import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// AccessLogsPanel also resolves acting-person names via GET /users and
// (lazily, on ticket click) the record's type via GET /entities/:id — this
// mock routes by URL so the log-list response queued per test isn't
// accidentally consumed by one of those other calls instead.
let queuedLogsResponse: {
  data: unknown[];
  nextCursor: string | null;
} = { data: [], nextCursor: null };
const mockFetchWithAuth = vi.fn((url: string): Promise<unknown> => {
  if (url.includes("/users")) return Promise.resolve({ data: [] });
  return Promise.resolve(queuedLogsResponse);
});
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

vi.mock("../entity-type-context.js", () => ({
  useEntityTypes: () => ({ getTypeById: () => undefined }),
  toTypeSlug: (name: string) => name.toLowerCase(),
}));

const { ThirdPartyAccessLogsPage } =
  await import("./third-party-access-logs.js");

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ThirdPartyAccessLogsPage />
    </MemoryRouter>,
  );
}

describe("ThirdPartyAccessLogsPage", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes("/users")) return Promise.resolve({ data: [] });
      return Promise.resolve(queuedLogsResponse);
    });
    queuedLogsResponse = { data: [], nextCursor: null };
  });

  it("renders rows including one denied outcome and the residual-risk caveat", async () => {
    queuedLogsResponse = {
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
    };

    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Acme Sync").length).toBe(2);
    });
    // No matching org member was resolved (mocked /users returns none), so
    // the table falls back to the raw acting-person id.
    expect(screen.getByText("person-a")).toBeTruthy();
    expect(screen.getByText("person-b")).toBeTruthy();
    expect(screen.getByText(/known residual risk/i)).toBeTruthy();
  });

  it("resolves an acting-person id to its org member display name when one matches", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes("/users")) {
        return Promise.resolve({
          data: [{ userId: "person-a", displayName: "Jane Doe" }],
        });
      }
      return Promise.resolve(queuedLogsResponse);
    });
    queuedLogsResponse = {
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
      nextCursor: null,
    };

    renderPage();

    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());
    expect(screen.queryByText("person-a")).toBeNull();
  });

  it("renders an anonymized/placeholder row without erroring (spec R6)", async () => {
    queuedLogsResponse = {
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
    };

    renderPage();

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
    queuedLogsResponse = {
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
    };

    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Load more")).toBeTruthy();
    });

    // Edit the Application field WITHOUT clicking "Apply filters".
    fireEvent.change(screen.getByPlaceholderText("api key uuid"), {
      target: { value: "unapplied-key-id" },
    });

    const logsCallsBefore = mockFetchWithAuth.mock.calls.filter(
      ([url]) => !(url as string).includes("/users"),
    ).length;
    queuedLogsResponse = { data: [], nextCursor: null };
    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => {
      const logsCalls = mockFetchWithAuth.mock.calls.filter(
        ([url]) => !(url as string).includes("/users"),
      );
      expect(logsCalls.length).toBe(logsCallsBefore + 1);
    });
    const logsCalls = mockFetchWithAuth.mock.calls.filter(
      ([url]) => !(url as string).includes("/users"),
    );
    const loadMoreUrl = logsCalls[logsCalls.length - 1]?.[0] as string;
    expect(loadMoreUrl).toContain("cursor=cursor-1");
    expect(loadMoreUrl).not.toContain("unapplied-key-id");
  });

  it("shows the empty state when no rows match", async () => {
    queuedLogsResponse = { data: [], nextCursor: null };

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No matching requests")).toBeTruthy();
    });
  });
});
