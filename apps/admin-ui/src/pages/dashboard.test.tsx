import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";

vi.mock("@refinedev/core", () => ({
  useGetIdentity: () => ({
    data: { id: "u1", name: "Jane Doe", email: "jane@example.com" },
  }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

vi.mock("../entity-type-context.js", () => ({
  useEntityTypes: () => ({ getTypeById: () => undefined }),
  toTypeSlug: (s: string) => s,
}));

vi.mock("../lib/notifications-client.js", () => ({
  listNotifications: () => Promise.resolve({ data: [] }),
  getUnreadCount: () => Promise.resolve(0),
  markNotificationRead: () => Promise.resolve(),
}));

const EMPTY_MY_VIEW = {
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
  adminWorkflows: [],
  savedViews: [],
  pendingApprovals: { items: [], totalQualifying: 0 },
};

const mockFetchWithAuth = vi.fn((_url: string) =>
  Promise.resolve({ data: undefined as unknown }),
);
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { Dashboard } = await import("./dashboard.js");

describe("Dashboard — KPI tiles filter the My Tickets list", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
  });

  const overdueTicket = {
    entityId: "e-overdue",
    entityTypeId: "et-1",
    entityTypeName: "Ticket",
    workflowId: "wf-1",
    workflowName: "Helpdesk",
    stateName: "Open",
    title: "Overdue ticket",
    dueDate: new Date(Date.now() - 86_400_000).toISOString(),
    isOverdue: true,
  };
  const dueThisWeekTicket = {
    entityId: "e-dueweek",
    entityTypeId: "et-1",
    entityTypeName: "Ticket",
    workflowId: "wf-1",
    workflowName: "Helpdesk",
    stateName: "Open",
    title: "Due this week ticket",
    dueDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    isOverdue: false,
  };
  const atRiskTicket = {
    entityId: "e-atrisk",
    entityTypeId: "et-1",
    entityTypeName: "Ticket",
    workflowId: "wf-1",
    workflowName: "Helpdesk",
    stateName: "Open",
    title: "At risk ticket",
    dueDate: null,
    isOverdue: false,
  };
  const VIEW_WITH_TICKETS = {
    ...EMPTY_MY_VIEW,
    tickets: {
      items: [overdueTicket, dueThisWeekTicket, atRiskTicket],
      totalQualifying: 3,
    },
    slaRisk: {
      items: [
        {
          entityId: "e-atrisk",
          entityTypeId: "et-1",
          entityTypeName: "Ticket",
          title: "At risk ticket",
          workflowId: "wf-1",
          stateName: "Open",
          hoursOver: 5,
        },
      ],
      totalQualifying: 1,
    },
  };

  function mockMyView(): void {
    mockFetchWithAuth.mockImplementation(() =>
      Promise.resolve({ data: VIEW_WITH_TICKETS }),
    );
  }

  // The SLA Risk side panel independently lists "At risk ticket" too (it's a
  // separate signal, §V), so ticket-list assertions scope to the My Tickets
  // <table> via `within` to avoid colliding with that panel's own rendering.
  function ticketTable(): HTMLElement {
    return screen.getByRole("table");
  }

  it("defaults to 'My Tickets' active, showing every ticket", async () => {
    mockMyView();
    render(<Dashboard />);

    await waitFor(() =>
      expect(within(ticketTable()).getByText("Overdue ticket")).toBeDefined(),
    );
    expect(
      within(ticketTable()).getByText("Due this week ticket"),
    ).toBeDefined();
    expect(within(ticketTable()).getByText("At risk ticket")).toBeDefined();

    const kpiStrip = document.querySelector(".dash-kpi");
    const myTicketsTile = within(kpiStrip as HTMLElement).getByText(
      "My Tickets",
    ).parentElement?.parentElement;
    expect(myTicketsTile?.style.background).toBe("rgb(0, 111, 230)");
  });

  it("filters to only overdue tickets when the Overdue tile is clicked, and highlights it", async () => {
    mockMyView();
    render(<Dashboard />);

    await waitFor(() =>
      expect(within(ticketTable()).getByText("Overdue ticket")).toBeDefined(),
    );

    fireEvent.click(screen.getByText("Overdue"));

    expect(within(ticketTable()).getByText("Overdue ticket")).toBeDefined();
    expect(
      within(ticketTable()).queryByText("Due this week ticket"),
    ).toBeNull();
    expect(within(ticketTable()).queryByText("At risk ticket")).toBeNull();
  });

  it("filters to only at-risk tickets when the At SLA Risk tile is clicked", async () => {
    mockMyView();
    render(<Dashboard />);

    await waitFor(() =>
      expect(within(ticketTable()).getByText("Overdue ticket")).toBeDefined(),
    );

    fireEvent.click(screen.getByText("At SLA Risk"));

    expect(within(ticketTable()).getByText("At risk ticket")).toBeDefined();
    expect(within(ticketTable()).queryByText("Overdue ticket")).toBeNull();
    expect(
      within(ticketTable()).queryByText("Due this week ticket"),
    ).toBeNull();
  });

  it("filters to only tickets due this week when the Due This Week tile is clicked", async () => {
    mockMyView();
    render(<Dashboard />);

    await waitFor(() =>
      expect(within(ticketTable()).getByText("Overdue ticket")).toBeDefined(),
    );

    fireEvent.click(screen.getByText("Due This Week"));

    expect(
      within(ticketTable()).getByText("Due this week ticket"),
    ).toBeDefined();
    expect(within(ticketTable()).queryByText("Overdue ticket")).toBeNull();
    expect(within(ticketTable()).queryByText("At risk ticket")).toBeNull();
  });

  it("paginates the My Tickets list at 10 per page and resets to page 1 on KPI-tile change", async () => {
    const manyTickets = Array.from({ length: 25 }, (_, i) => ({
      entityId: `e-${i}`,
      entityTypeId: "et-1",
      entityTypeName: "Ticket",
      workflowId: "wf-1",
      workflowName: "Helpdesk",
      stateName: "Open",
      title: `Ticket ${String(i).padStart(2, "0")}`,
      dueDate: null,
      isOverdue: false,
    }));
    mockFetchWithAuth.mockImplementation(() =>
      Promise.resolve({
        data: {
          ...EMPTY_MY_VIEW,
          workflows: [
            {
              workflowId: "wf-1",
              workflowName: "Helpdesk",
              counts: [],
              total: 25,
            },
          ],
          tickets: { items: manyTickets, totalQualifying: 25 },
        },
      }),
    );

    render(<Dashboard />);

    await waitFor(() =>
      expect(within(ticketTable()).getByText("Ticket 00")).toBeDefined(),
    );
    expect(within(ticketTable()).queryByText("Ticket 10")).toBeNull();
    expect(screen.getByText("1–10 of 25")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(within(ticketTable()).getByText("Ticket 10")).toBeDefined();
    expect(within(ticketTable()).queryByText("Ticket 00")).toBeNull();

    // Narrowing via search changes the underlying item set, so pagination
    // should snap back to page 1 rather than stranding on a stale page.
    fireEvent.change(screen.getByPlaceholderText(/search by title/i), {
      target: { value: "Ticket 0" },
    });
    expect(within(ticketTable()).getByText("Ticket 00")).toBeDefined();
  });
});
