import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const mockFetchWithAuth = vi.fn(
  (_url: string, _options?: RequestInit): Promise<unknown> =>
    Promise.resolve({ data: {} }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, options?: RequestInit) =>
    mockFetchWithAuth(url, options),
  API_URL: "/api",
}));

const { CreateSandboxModal } = await import("./create-sandbox-modal.js");

function renderModal(
  onCreated: () => void = vi.fn(),
  onClose: () => void = vi.fn(),
): { onCreated: () => void; onClose: () => void } {
  render(
    <CreateSandboxModal open={true} onClose={onClose} onCreated={onCreated} />,
  );
  return { onCreated, onClose };
}

describe("CreateSandboxModal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("submits the form and starts provisioning", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockResolvedValue({
      data: {
        status: "running",
        currentStep: "creating_org",
        completedSteps: 1,
        totalSteps: 5,
        error: null,
      },
    });
    renderModal();

    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/platform-admin/sandboxes",
        {
          method: "POST",
          body: JSON.stringify({ orgName: "Acme", trialDays: 14 }),
        },
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Creating sandbox…")).toBeTruthy();
    });
  });

  it("does not submit with an empty org name", () => {
    renderModal();

    const button = screen.getByText("Create sandbox") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("polls progress and shows the current step", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockResolvedValue({
      data: {
        status: "running",
        currentStep: "creating accounts (2/5)",
        completedSteps: 2,
        totalSteps: 7,
        error: null,
      },
    });
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("creating accounts (2/5)")).toBeTruthy();
      expect(screen.getByText("2 / 7")).toBeTruthy();
    });
  });

  it("fetches and shows the handover screen once provisioning completes", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: {
        status: "completed",
        currentStep: null,
        completedSteps: 7,
        totalSteps: 7,
        error: null,
      },
    });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: {
        tenantId: "t1",
        seededAccounts: [{ email: "admin@example.com", role: "admin" }],
        defaultPassword: "Ow-abc-9!",
      },
    });
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("Sandbox ready")).toBeTruthy();
      expect(screen.getByText("Ow-abc-9!")).toBeTruthy();
      expect(screen.getByText(/admin@example.com/)).toBeTruthy();
    });
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/platform-admin/sandboxes/job-1/handover",
      undefined,
    );
  });

  it("calls onCreated when Done is clicked on the handover screen", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: {
        status: "completed",
        currentStep: null,
        completedSteps: 1,
        totalSteps: 1,
        error: null,
      },
    });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: { tenantId: "t1", seededAccounts: [], defaultPassword: "pw" },
    });
    const { onCreated } = renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => screen.getByText("Sandbox ready"));
    fireEvent.click(screen.getByText("Done"));

    expect(onCreated).toHaveBeenCalled();
  });

  it("shows the job error and a close action when provisioning fails", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockResolvedValue({
      data: {
        status: "failed",
        currentStep: null,
        completedSteps: 2,
        totalSteps: 7,
        error: "SANDBOX_ORG_CREATE_FAILED",
      },
    });
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("SANDBOX_ORG_CREATE_FAILED")).toBeTruthy();
      expect(screen.getByText("Close")).toBeTruthy();
    });
  });

  it("shows an inline error when starting provisioning itself fails", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("quota exceeded"));
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("quota exceeded")).toBeTruthy();
    });
  });
});
