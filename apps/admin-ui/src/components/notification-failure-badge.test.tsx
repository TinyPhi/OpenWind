import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";

vi.mock("../lib/api.js", () => ({
  fetchWithAuth: vi.fn(),
  API_URL: "/api",
}));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { NotificationFailureBadge } =
  await import("./notification-failure-badge.js");

const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const minutesAgo = (m: number): string =>
  new Date(Date.now() - m * 60_000).toISOString();

function failures(rows: { channel: string; minutes: number }[]): unknown {
  return {
    data: {
      failures: rows.map((r) => ({
        channel: r.channel,
        occurredAt: minutesAgo(r.minutes),
      })),
    },
  };
}

describe("NotificationFailureBadge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it("shows the failed channels and how long ago the latest failure was", async () => {
    fetchWithAuth.mockResolvedValue(
      failures([
        { channel: "sms", minutes: 5 },
        { channel: "email", minutes: 90 },
        { channel: "sms", minutes: 120 },
      ]),
    );

    render(<NotificationFailureBadge ticketId="t-1" enabled />);

    const badge = await screen.findByText(
      "Notification failed: sms, email · 5m ago",
    );
    expect(badge.getAttribute("role")).toBe("status");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "/api/entities/t-1/notification-failures",
    );
  });

  it("shows nothing while the lookup is pending", () => {
    fetchWithAuth.mockReturnValue(new Promise(() => undefined));

    render(<NotificationFailureBadge ticketId="t-1" enabled />);

    expect(screen.queryByText(/Notification failed/)).toBeNull();
  });

  it("shows nothing when there are no failures", async () => {
    fetchWithAuth.mockResolvedValue(failures([]));

    render(<NotificationFailureBadge ticketId="t-1" enabled />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(/Notification failed/)).toBeNull();
  });

  it("shows nothing when the lookup fails", async () => {
    fetchWithAuth.mockRejectedValue(new Error("403"));

    render(<NotificationFailureBadge ticketId="t-1" enabled />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(/Notification failed/)).toBeNull();
  });

  it("shows nothing for a malformed response", async () => {
    fetchWithAuth.mockResolvedValue({ data: { failures: [{ channel: 3 }] } });

    render(<NotificationFailureBadge ticketId="t-1" enabled />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await flush();
    expect(screen.queryByText(/Notification failed/)).toBeNull();
  });

  it("makes no request and shows nothing when the viewer is not staff", () => {
    fetchWithAuth.mockResolvedValue(failures([{ channel: "sms", minutes: 1 }]));

    render(<NotificationFailureBadge ticketId="t-1" enabled={false} />);

    expect(screen.queryByText(/Notification failed/)).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("drops the previous ticket's badge while a different ticket loads", async () => {
    fetchWithAuth.mockResolvedValueOnce(
      failures([{ channel: "sms", minutes: 1 }]),
    );
    const { rerender } = render(
      <NotificationFailureBadge ticketId="t-1" enabled />,
    );
    await screen.findByText(/Notification failed/);

    fetchWithAuth.mockReturnValueOnce(new Promise(() => undefined));
    rerender(<NotificationFailureBadge ticketId="t-2" enabled />);

    await waitFor(() =>
      expect(screen.queryByText(/Notification failed/)).toBeNull(),
    );
  });
});
