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
const USER_A = { userId: "u-1", displayName: "Jane Doe" };
const TEAM_A = { id: "team-1", name: "Platform Team" };

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
  template: {
    title: "Weekly Standup",
    teamId: "team-1",
    due_days: 2,
    remark: "Auto-created weekly standup ticket.",
  },
};

// Every refresh() fires 4 fetches in this order: rules, workflows, users, teams.
function queueRefresh(rulesData: unknown): void {
  mockFetchWithAuth.mockResolvedValueOnce({ data: rulesData });
  mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
  mockFetchWithAuth.mockResolvedValueOnce({ data: [USER_A] });
  mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
}

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

  it("renders the rule list with humanized cron and workflow name", async () => {
    queueRefresh([RULE_A]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );
    expect(screen.getByText(/At 09:00 on Monday/)).toBeTruthy();
    expect(screen.getByText("Ticket Workflow")).toBeTruthy();
  });

  it("shows an empty state when there are no rules", async () => {
    queueRefresh([]);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No schedule rules yet")).toBeTruthy(),
    );
  });

  it("opens the create modal, walks the 2-step wizard (scheduling -> ticket template), and posts a new rule with a computed cron expression", async () => {
    queueRefresh([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No schedule rules yet")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("New Rule"));

    // Step 1: Scheduling -- no raw cron textbox; a Repeats toggle + day/time
    // pickers compute the equivalent cron expression instead.
    expect(screen.queryByLabelText(/Cron Expression/)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("e.g. Weekly Standup"), {
      target: { value: "Monthly Review" },
    });
    fireEvent.click(screen.getByText("monthly"));
    fireEvent.change(screen.getByLabelText("Day of month"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "09:00" },
    });
    fireEvent.click(screen.getByText("Next: Ticket template →"));

    // Step 2: Ticket template.
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("e.g. Weekly standup — {{date}}"),
      ).toBeTruthy(),
    );
    fireEvent.change(
      screen.getByPlaceholderText("e.g. Weekly standup — {{date}}"),
      {
        target: { value: "Monthly Review — {{month}}" },
      },
    );
    // Mandate fields -- defaults to Team mode; pick the team, due-days
    // offset, and remark (all required client-side before submit).
    const teamSelect = screen.getByText("Select a team…").closest("select");
    if (!teamSelect) throw new Error("team select not found");
    fireEvent.change(teamSelect, { target: { value: TEAM_A.id } });
    fireEvent.change(screen.getByLabelText(/Due — days after creation/), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/Remark/), {
      target: { value: "Auto-created by the monthly review rule." },
    });

    mockFetchWithAuth.mockResolvedValueOnce({ data: RULE_A });
    queueRefresh([RULE_A]);
    fireEvent.click(screen.getByText("Create rule"));

    function findPostCall(): unknown[] | undefined {
      return mockFetchWithAuth.mock.calls.find(
        (call) =>
          call[0] === "/api/admin/schedule-rules" &&
          (call[1] as { method?: string } | undefined)?.method === "POST",
      );
    }
    await waitFor(() => expect(findPostCall()).toBeTruthy());
    const postInit = findPostCall()?.[1] as { method: string; body: string };
    expect(postInit.method).toBe("POST");
    const postBody = JSON.parse(postInit.body) as {
      cronExpr: string;
      entityTypeId?: unknown;
    };
    expect(postBody.cronExpr).toBe("0 9 1 * *");
    // 2026-09-22 incident: the client used to guess entityTypeId from a
    // possibly-paginated entity-types list and could silently send the
    // wrong one -- it must never be sent at all now; the server resolves
    // the tenant's "ticket" entity type itself.
    expect(postBody.entityTypeId).toBeUndefined();
  });

  it("prefills the frequency picker from an existing rule's cron expression when editing", async () => {
    queueRefresh([RULE_A]); // RULE_A.cronExpr = "0 9 * * 1" (weekly, Monday, 09:00)
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Edit rule"));

    await waitFor(() =>
      expect(screen.getByDisplayValue("Weekly Standup")).toBeTruthy(),
    );
    const daySelect = screen.getByLabelText("Day") as HTMLSelectElement;
    expect(daySelect.value).toBe("1");
    const timeInput = screen.getByLabelText("Time") as HTMLInputElement;
    expect(timeInput.value).toBe("09:00");
  });

  it("computes a weekly cron expression from the frequency picker on save", async () => {
    queueRefresh([RULE_A]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );

    fireEvent.click(screen.getByLabelText("Edit rule"));
    await waitFor(() => expect(screen.getByLabelText("Day")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Day"), {
      target: { value: "5" }, // Friday
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "14:30" },
    });
    fireEvent.click(screen.getByText("Next: Ticket template →"));

    await waitFor(() => expect(screen.getByText("Save changes")).toBeTruthy());
    mockFetchWithAuth.mockResolvedValueOnce({ data: RULE_A });
    queueRefresh([RULE_A]);
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(
        mockFetchWithAuth.mock.calls.some(
          (call) => call[0] === "/api/admin/schedule-rules/rule-1",
        ),
      ).toBe(true),
    );
    const patchCall = mockFetchWithAuth.mock.calls.find(
      (call) => call[0] === "/api/admin/schedule-rules/rule-1",
    );
    const patchInit = patchCall?.[1] as { method: string; body: string };
    expect(patchInit.method).toBe("PATCH");
    expect((JSON.parse(patchInit.body) as { cronExpr: string }).cronExpr).toBe(
      "30 14 * * 5",
    );
  });

  it("lets you search and pick a workflow from a searchable dropdown", async () => {
    queueRefresh([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No schedule rules yet")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("New Rule"));
    fireEvent.click(screen.getByText("Search and select a workflow…"));
    fireEvent.change(screen.getByPlaceholderText("Search…"), {
      target: { value: "Ticket" },
    });
    fireEvent.click(screen.getByText("Ticket Workflow"));

    expect(screen.getAllByText("Ticket Workflow").length).toBeGreaterThan(0);
  });

  it("offers common timezones as a picker instead of a free-text IANA input", async () => {
    queueRefresh([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No schedule rules yet")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("New Rule"));

    const tzSelect = screen.getByLabelText(/Timezone/) as HTMLSelectElement;
    expect(tzSelect.tagName).toBe("SELECT");
    fireEvent.change(tzSelect, { target: { value: "Asia/Kolkata" } });
    expect(tzSelect.value).toBe("Asia/Kolkata");
  });

  it("toggles pause/resume on a rule", async () => {
    queueRefresh([RULE_A]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Weekly Standup")).toBeTruthy(),
    );

    mockFetchWithAuth.mockResolvedValueOnce({ data: {} });
    queueRefresh([{ ...RULE_A, status: "paused" }]);
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
