import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import type * as ReactRouterDom from "react-router-dom";

// docs/specs/my-org-view.md R3/R7/R8 — rendering coverage for OrgDashboardBody,
// the presentational piece dashboard.tsx mounts inline (R4, amended
// ). TeamMemberRow navigates on click (R9, "view as subordinate"),
// so useNavigate needs mocking even though this suite never asserts on it.

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockFetchWithAuth = vi.fn((_url: string) =>
  Promise.resolve({ data: undefined as unknown }),
);
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { OrgDashboardBody } = await import("./dashboard-org.js");

const onOpenRecord = vi.fn();

const BASE_VIEW = {
  hasReports: true,
  truncated: false,
  unavailable: false,
  workflows: [],
  tickets: { items: [], totalQualifying: 0 },
  dueDates: { items: [], totalQualifying: 0 },
  slaRisk: { items: [], totalQualifying: 0 },
  teamMembers: { items: [] },
};

describe("OrgDashboardBody", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    onOpenRecord.mockReset();
    mockNavigate.mockReset();
  });

  it("shows an unavailable message (never an error) when the org view failed to load", () => {
    render(
      <OrgDashboardBody
        view={{ ...BASE_VIEW, unavailable: true }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(screen.getByText(/could not be loaded/i)).toBeDefined();
  });

  it("shows a loading spinner while loading", () => {
    render(
      <OrgDashboardBody
        view={BASE_VIEW}
        loading={true}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(screen.getByLabelText(/loading org view/i)).toBeDefined();
  });

  it("warns when ticket totals and roster counts come from a truncated scope", () => {
    render(
      <OrgDashboardBody
        view={{ ...BASE_VIEW, truncated: true }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(
      screen.getByText(/most recently created 2,000 tickets/i),
    ).toBeDefined();
  });

  it("renders team tickets/KPIs and the team roster when data is available", async () => {
    render(
      <OrgDashboardBody
        view={{
          ...BASE_VIEW,
          workflows: [
            {
              workflowId: "wf-1",
              workflowName: "Helpdesk",
              counts: [{ stateId: "open", stateName: "Open", count: 2 }],
              total: 2,
            },
          ],
          tickets: {
            items: [
              {
                entityId: "e1",
                entityTypeId: "et-1",
                entityTypeName: "Ticket",
                workflowId: "wf-1",
                workflowName: "Helpdesk",
                stateName: "Open",
                title: "Report's ticket",
                dueDate: null,
                isOverdue: false,
                assignedTo: "u1",
                assignedToName: "Report Assignee",
              },
            ],
            totalQualifying: 1,
          },
          teamMembers: {
            items: [
              {
                userId: "u1",
                name: "Priyanka Kushwaha",
                ticketCount: 4,
                overdueCount: 1,
              },
              {
                userId: "u2",
                name: "Deepika Sijwali",
                ticketCount: 0,
                overdueCount: 0,
              },
            ],
          },
        }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Report's ticket")).toBeDefined(),
    );
    expect(screen.getAllByText("Helpdesk").length).toBeGreaterThan(0);
    expect(screen.getByText("Priyanka Kushwaha")).toBeDefined();
    expect(screen.getByText("Deepika Sijwali")).toBeDefined();
    expect(screen.getByText("Report Assignee")).toBeDefined();

    // R9 — clicking a team member's name navigates to their own dashboard.
    fireEvent.click(screen.getByText("Priyanka Kushwaha"));
    expect(mockNavigate).toHaveBeenCalledWith("/dashboard/team/u1");
  });

  it("filters the Team Tickets list to Overdue/Due in 2 Days/All", () => {
    const overdue = {
      entityId: "e-overdue",
      entityTypeId: "et-1",
      entityTypeName: "Ticket",
      workflowId: "wf-1",
      workflowName: "Helpdesk",
      stateName: "Open",
      title: "Overdue ticket",
      dueDate: new Date(Date.now() - 86_400_000).toISOString(),
      isOverdue: true,
      assignedTo: "u1",
      assignedToName: "Report Assignee",
    };
    const notDue = {
      entityId: "e-notdue",
      entityTypeId: "et-1",
      entityTypeName: "Ticket",
      workflowId: "wf-1",
      workflowName: "Helpdesk",
      stateName: "Open",
      title: "Not due soon",
      dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      isOverdue: false,
      assignedTo: "u1",
      assignedToName: "Report Assignee",
    };

    render(
      <OrgDashboardBody
        view={{
          ...BASE_VIEW,
          tickets: { items: [overdue, notDue], totalQualifying: 2 },
        }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(screen.getByText("Overdue ticket")).toBeDefined();
    expect(screen.getByText("Not due soon")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^Overdue/ }));
    expect(screen.getByText("Overdue ticket")).toBeDefined();
    expect(screen.queryByText("Not due soon")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText("Overdue ticket")).toBeDefined();
    expect(screen.getByText("Not due soon")).toBeDefined();
  });

  it("searches Team Tickets by ticket title or team member name", () => {
    const ticketA = {
      entityId: "e-a",
      entityTypeId: "et-1",
      entityTypeName: "Ticket",
      workflowId: "wf-1",
      workflowName: "Helpdesk",
      stateName: "Open",
      title: "Fix login bug",
      dueDate: null,
      isOverdue: false,
      assignedTo: "u1",
      assignedToName: "Priyanka Kushwaha",
    };
    const ticketB = {
      entityId: "e-b",
      entityTypeId: "et-1",
      entityTypeName: "Ticket",
      workflowId: "wf-1",
      workflowName: "Helpdesk",
      stateName: "Open",
      title: "Update invoice template",
      dueDate: null,
      isOverdue: false,
      assignedTo: "u2",
      assignedToName: "Deepika Sijwali",
    };

    render(
      <OrgDashboardBody
        view={{
          ...BASE_VIEW,
          tickets: { items: [ticketA, ticketB], totalQualifying: 2 },
        }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(screen.getByText("Fix login bug")).toBeDefined();
    expect(screen.getByText("Update invoice template")).toBeDefined();

    // Search by ticket title
    fireEvent.change(
      screen.getByPlaceholderText(/search by ticket or team member/i),
      {
        target: { value: "login" },
      },
    );
    expect(screen.getByText("Fix login bug")).toBeDefined();
    expect(screen.queryByText("Update invoice template")).toBeNull();

    // Search by team member name
    fireEvent.change(
      screen.getByPlaceholderText(/search by ticket or team member/i),
      {
        target: { value: "Deepika" },
      },
    );
    expect(screen.getByText("Update invoice template")).toBeDefined();
    expect(screen.queryByText("Fix login bug")).toBeNull();
  });

  it("shows an empty-roster message when the team has no members", () => {
    render(
      <OrgDashboardBody
        view={BASE_VIEW}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(screen.getByText(/no direct or indirect reports/i)).toBeDefined();
  });

  it("paginates the Team roster at 10 per page and Next/Prev walks through it", () => {
    const members = Array.from({ length: 25 }, (_, i) => ({
      userId: `u-${i}`,
      name: `Member ${String(i).padStart(2, "0")}`,
      ticketCount: 25 - i,
      overdueCount: 0,
    }));

    render(
      <OrgDashboardBody
        view={{ ...BASE_VIEW, teamMembers: { items: members } }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    // Sorted by ticketCount desc, so page 1 is Member 00..09.
    expect(screen.getByText("Member 00")).toBeDefined();
    expect(screen.getByText("Member 09")).toBeDefined();
    expect(screen.queryByText("Member 10")).toBeNull();
    expect(screen.getByText("1–10 of 25")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("Member 10")).toBeDefined();
    expect(screen.queryByText("Member 00")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /prev/i }));
    expect(screen.getByText("Member 00")).toBeDefined();
  });

  it("paginates the Team Tickets list and resets to page 1 when the filter changes", () => {
    const tickets = Array.from({ length: 15 }, (_, i) => ({
      entityId: `e-${i}`,
      entityTypeId: "et-1",
      entityTypeName: "Ticket",
      workflowId: "wf-1",
      workflowName: "Helpdesk",
      stateName: "Open",
      title: `Ticket ${String(i).padStart(2, "0")}`,
      dueDate: null,
      isOverdue: false,
      assignedTo: "u1",
      assignedToName: "Report Assignee",
    }));

    render(
      <OrgDashboardBody
        view={{
          ...BASE_VIEW,
          tickets: { items: tickets, totalQualifying: 15 },
        }}
        loading={false}
        onOpenRecord={onOpenRecord}
      />,
    );

    expect(screen.getByText("Ticket 00")).toBeDefined();
    expect(screen.queryByText("Ticket 10")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("Ticket 10")).toBeDefined();
    expect(screen.queryByText("Ticket 00")).toBeNull();

    // Changing the filter should snap back to page 1.
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText("Ticket 00")).toBeDefined();
  });
});
