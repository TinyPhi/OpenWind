import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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

interface EntityTypeContextValue {
  entityTypes: { id: string; name: string; plural: string }[];
  modules: unknown[];
  getTypeBySlug: (slug: string) => unknown;
  getTypeById: (id: string) => unknown;
  reload: () => void;
}
const mockUseEntityTypes = vi.fn(
  (): EntityTypeContextValue => ({
    entityTypes: [],
    modules: [],
    getTypeBySlug: () => undefined,
    getTypeById: () => undefined,
    reload: () => undefined,
  }),
);
vi.mock("../../entity-type-context.js", () => ({
  useEntityTypes: () => mockUseEntityTypes(),
}));

const { ScheduleRulesPage } = await import("./index.js");

const ENTITY_TYPE_A = {
  id: "et-1",
  name: "ticket",
  plural: "Tickets",
  icon: null,
  moduleId: null,
};

const WORKFLOW_A = { id: "wf-1", name: "Ticket Workflow" };

const RULE_A = {
  id: "rule-1",
  name: "Weekly Standup",
  description: null,
  cronExpr: "0 9 * * 1",
  cronHuman: "At 09:00 on Monday",
  timezone: "UTC",
  status: "active",
  entityTypeId: "et-1",
  workflowId: "wf-1",
  catchUp: false,
  nextFireAt: "2026-09-22T09:00:00Z",
  template: { title: "Weekly Standup" },
};

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ScheduleRulesPage />
    </MemoryRouter>,
  );
}

describe("ScheduleRulesPage", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
    mockUseEntityTypes.mockReturnValue({
      entityTypes: [ENTITY_TYPE_A],
      modules: [],
      getTypeBySlug: () => undefined,
      getTypeById: () => ENTITY_TYPE_A,
      reload: () => undefined,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the rule list with humanized cron and entity type", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [RULE_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );
    expect(screen.getByText(/At 09:00 on Monday/)).toBeTruthy();
    expect(screen.getByText("Tickets")).toBeTruthy();
  });

  it("shows an empty state when there are no rules", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No schedule rules yet")).toBeTruthy(),
    );
  });

  it("opens the create modal, fills a cron preset, and posts a new rule", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No schedule rules yet")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("New Rule"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Weekly Standup"), {
      target: { value: "Monthly Review" },
    });
    fireEvent.change(screen.getByLabelText("Repeats"), {
      target: { value: "monthly" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Weekly standup — {{date}}"),
      {
        target: { value: "Monthly Review — {{month}}" },
      },
    );

    mockFetchWithAuth.mockResolvedValueOnce({ data: RULE_A });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [RULE_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    fireEvent.click(screen.getByText("Create rule"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/admin/schedule-rules",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("toggles pause/resume on a rule", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [RULE_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );

    mockFetchWithAuth.mockResolvedValueOnce({ data: {} });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [{ ...RULE_A, status: "paused" }],
    });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    fireEvent.click(screen.getByLabelText("Pause rule"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/admin/schedule-rules/rule-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "paused" }),
        }),
      ),
    );
  });
});
