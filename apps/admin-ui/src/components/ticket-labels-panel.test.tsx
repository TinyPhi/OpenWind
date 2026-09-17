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
vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockShowAlert = vi.fn((_message: string): void => undefined);
vi.mock("./global-alert-dialog.js", () => ({
  showAlert: (message: string) => mockShowAlert(message),
}));

const { TicketLabelsPanel } = await import("./ticket-labels-panel.js");

const ASSIGNED_LABEL = {
  labelId: "label-1",
  name: "Urgent",
  color: "#dc2626",
  description: null,
};

const AVAILABLE_LABELS = [
  { id: "label-1", name: "Urgent", color: "#dc2626" },
  { id: "label-2", name: "Billing", color: "#2563eb" },
];

describe("TicketLabelsPanel", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders assigned labels as chips", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ASSIGNED_LABEL] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: AVAILABLE_LABELS });
    render(<TicketLabelsPanel ticketId="ticket-1" />);

    await waitFor(() => expect(screen.getByText("Urgent")).toBeTruthy());
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/entities/ticket-1/labels",
    );
  });

  it("only offers unassigned labels in the add-label picker", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ASSIGNED_LABEL] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: AVAILABLE_LABELS });
    render(<TicketLabelsPanel ticketId="ticket-1" />);
    await waitFor(() => expect(screen.getByText("Urgent")).toBeTruthy());

    fireEvent.click(screen.getByText("+ Add label"));
    expect(screen.getByText("Billing")).toBeTruthy();
    expect(screen.queryAllByText("Urgent")).toHaveLength(1);
  });

  it("assigns a label and refreshes the list", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: AVAILABLE_LABELS });
    render(<TicketLabelsPanel ticketId="ticket-1" />);
    await waitFor(() => expect(screen.getByText("+ Add label")).toBeTruthy());

    fireEvent.click(screen.getByText("+ Add label"));
    mockFetchWithAuth.mockResolvedValueOnce({ data: {} });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ASSIGNED_LABEL] });
    fireEvent.click(screen.getByText("Urgent"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/entities/ticket-1/labels",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("removes a label when its remove control is clicked", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ASSIGNED_LABEL] });
    mockFetchWithAuth.mockResolvedValueOnce({ data: AVAILABLE_LABELS });
    render(<TicketLabelsPanel ticketId="ticket-1" />);
    await waitFor(() => expect(screen.getByText("Urgent")).toBeTruthy());

    mockFetchWithAuth.mockResolvedValueOnce({ data: {} });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    fireEvent.click(screen.getByLabelText("Remove Urgent"));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/entities/ticket-1/labels/label-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
