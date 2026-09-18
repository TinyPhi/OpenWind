import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

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

const { NotificationPoliciesPage } = await import("./index.js");

const TEAM_A = { id: "team-1", name: "Platform On-Call" };
const WORKFLOW_A = { id: "wf-1", name: "Ticket Workflow" };

const POLICY_A = {
  id: "policy-1",
  teamId: "team-1",
  workflowTypeId: null,
  severity: "critical",
  channels: ["email", "sms"],
  notifyBackup: true,
  notifyEscalationManager: false,
};

function renderPage(): ReturnType<typeof render> {
  return render(<NotificationPoliciesPage />);
}

describe("NotificationPoliciesPage", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the policy list with resolved team name and channels", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [POLICY_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    renderPage();

    await waitFor(() =>
      expect(
        screen
          .getAllByText("Platform On-Call")
          .some((el) => el.tagName === "TD"),
      ).toBe(true),
    );
    expect(screen.getByText("email, sms")).toBeTruthy();
    expect(
      screen.getAllByText("critical").some((el) => el.tagName === "TD"),
    ).toBe(true);
  });

  it("shows an empty state when there are no policies", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No notification policies yet")).toBeTruthy(),
    );
  });

  it("opens the create modal and posts a new policy", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No notification policies yet")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("New Policy"));

    mockFetchWithAuth.mockResolvedValueOnce({ data: POLICY_A });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [POLICY_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    fireEvent.click(screen.getByText("Create policy"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/admin/notification-policies",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("resolves a preview without mutating the policy list", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [POLICY_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [TEAM_A] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [WORKFLOW_A] });
    renderPage();
    await waitFor(() =>
      expect(
        screen
          .getAllByText("Platform On-Call")
          .some((el) => el.tagName === "TD"),
      ).toBe(true),
    );

    mockFetchWithAuth.mockResolvedValueOnce({
      data: {
        policyId: "policy-1",
        matchedAt: "team",
        channels: ["email"],
        notifyBackup: true,
        notifyEscalationManager: false,
        recipients: [],
      },
    });
    fireEvent.click(screen.getByText("Resolve"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining("/api/admin/notification-policies/resolve?"),
      ),
    );
    await waitFor(() => expect(screen.getByText("team")).toBeTruthy());
  });
});
