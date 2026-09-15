import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

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

const { ScheduleRuleDetailPage } = await import("./detail.js");

const RULE_A = {
  id: "rule-1",
  name: "Weekly Standup",
  description: null,
  cronExpr: "0 9 * * 1",
  cronHuman: "At 09:00 on Monday",
  timezone: "America/New_York",
  status: "active",
  entityTypeId: "et-1",
  workflowId: "wf-1",
  catchUp: false,
  nextFireAt: "2026-09-22T09:00:00Z",
  template: { title: "Weekly Standup" },
};

const EXECUTION_A = {
  id: "exec-1",
  scheduledAt: "2026-09-15T09:00:00Z",
  firedAt: "2026-09-15T09:00:03Z",
  status: "success",
  ticket: { id: "ticket-1", title: "Weekly Standup — 2026-09-15" },
  errorCode: null,
};

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/admin/schedule-rules/rule-1"]}>
      <Routes>
        <Route
          path="/admin/schedule-rules/:id"
          element={<ScheduleRuleDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ScheduleRuleDetailPage", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders rule info, next fires, and execution history", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: RULE_A });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [EXECUTION_A] });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: {
        timezone: "America/New_York",
        fires: ["2026-09-22T09:00:00Z", "2026-09-29T09:00:00Z"],
      },
    });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/admin/schedule-rules/rule-1/next-fires",
    );
    expect(screen.getByText("Weekly Standup — 2026-09-15")).toBeTruthy();
  });

  it("shows an empty-state message when there are no upcoming fires", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { ...RULE_A, status: "paused" },
    });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { timezone: "America/New_York", fires: [] },
    });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText("No upcoming fires (rule is paused or archived)."),
      ).toBeTruthy(),
    );
  });
});
