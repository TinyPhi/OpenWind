import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import "../../i18n.js";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import type * as SandboxHandoverCsvModule from "./sandbox-handover-csv.js";

const mockFetchWithAuth = vi.fn(
  (_url: string, _options?: RequestInit): Promise<unknown> =>
    Promise.resolve({ data: {} }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, options?: RequestInit) =>
    mockFetchWithAuth(url, options),
  API_URL: "/api",
}));

// The CSV content itself is covered by sandbox-handover-csv.test.ts; here only the wiring.
const mockDownloadHandoverCsv = vi.fn();
const mockWriteText = vi.fn();
vi.mock("./sandbox-handover-csv.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxHandoverCsvModule>();
  return {
    ...actual,
    downloadHandoverCsv: (...args: unknown[]) =>
      mockDownloadHandoverCsv(...args) as unknown,
  };
});

const { CreateSandboxModal } = await import("./create-sandbox-modal.js");

const HANDOVER_ACCOUNTS = [
  {
    username: "admin.user",
    email: "admin@example.com",
    role: "admin",
    password: "Ow-admin-9!",
  },
  {
    username: "olivia.smith",
    email: "olivia.smith@example.com",
    role: "user",
    password: "Ow-olivia-9!",
  },
];

async function showHandover(): Promise<void> {
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
    data: { tenantId: "t1", seededAccounts: HANDOVER_ACCOUNTS },
  });
  renderModal();
  fireEvent.change(screen.getByLabelText("Organization name"), {
    target: { value: "Acme Sandbox" },
  });
  fireEvent.click(screen.getByText("Create sandbox"));
  await waitFor(() => screen.getByText("Sandbox ready"));
}

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
    mockWriteText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      configurable: true,
      writable: true,
    });
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
        seededAccounts: [
          {
            username: "admin.user",
            email: "admin@example.com",
            role: "admin",
            password: "Ow-admin-9!",
          },
          {
            username: "olivia.smith",
            email: "olivia.smith@example.com",
            role: "user",
            password: "Ow-olivia-9!",
          },
        ],
      },
    });
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("Sandbox ready")).toBeTruthy();
      expect(screen.getByText(/admin@example.com/)).toBeTruthy();
      expect(screen.getByText("admin.user")).toBeTruthy();
      // Each account shows its own password; there is no shared one any more.
      expect(screen.getByText("Ow-admin-9!")).toBeTruthy();
      expect(screen.getByText("Ow-olivia-9!")).toBeTruthy();
      expect(screen.queryByText("Default password")).toBeNull();
      expect(screen.getByText(/either the username or the email/)).toBeTruthy();
    });
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      "/api/platform-admin/sandboxes/job-1/handover",
      undefined,
    );
  });

  it("downloads the on-screen accounts as a CSV named after the sandbox", async () => {
    await showHandover();

    fireEvent.click(screen.getByText("Download CSV"));

    expect(mockDownloadHandoverCsv).toHaveBeenCalledWith(
      "Acme Sandbox",
      HANDOVER_ACCOUNTS,
    );
    // Built from what's on screen: the handover is still fetched only once.
    const urls = mockFetchWithAuth.mock.calls.map(([url]) => url);
    expect(urls.filter((u) => u.endsWith("/handover"))).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an inline error when the CSV can't be created", async () => {
    mockDownloadHandoverCsv.mockImplementationOnce(() => {
      throw new Error("Blob unavailable");
    });
    await showHandover();

    fireEvent.click(screen.getByText("Download CSV"));

    expect(screen.getByRole("alert").textContent).toMatch(
      /Could not create the CSV/,
    );
    expect(screen.getByText("Ow-admin-9!")).toBeTruthy();
  });

  it("widens the dialog for the handover and gives email its own column", async () => {
    renderModal();
    expect(screen.getByRole("dialog").style.maxWidth).toBe("480px");
    cleanup();

    await showHandover();

    expect(screen.getByRole("dialog").style.maxWidth).toBe("960px");
    expect(screen.getByRole("columnheader", { name: "Email" })).toBeTruthy();
    expect(
      screen.getByRole("cell", { name: "olivia.smith@example.com" }),
    ).toBeTruthy();
  });

  // PR #842 review B: the handover endpoint is one-time. The server keeps answering
  // "completed" for a finished job, so this mock does too, and further poll intervals are
  // allowed to elapse -- the handover must still be fetched exactly once.
  it("fetches the one-time handover exactly once, even after more poll intervals", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.endsWith("/sandboxes")) {
        return Promise.resolve({ data: { jobId: "job-1" } });
      }
      if (url.endsWith("/progress")) {
        return Promise.resolve({
          data: {
            status: "completed",
            currentStep: null,
            completedSteps: 7,
            totalSteps: 7,
            error: null,
          },
        });
      }
      return Promise.resolve({
        data: {
          tenantId: "t1",
          seededAccounts: [
            {
              username: "admin.user",
              email: "admin@example.com",
              role: "admin",
              password: "Ow-abc-9!",
            },
          ],
        },
      });
    });
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => screen.getByText("Sandbox ready"));
    await vi.advanceTimersByTimeAsync(10_000);

    const urls = mockFetchWithAuth.mock.calls.map(([url]) => url);
    expect(urls.filter((u) => u.endsWith("/handover"))).toHaveLength(1);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);
  });

  it("does not submit a fractional trial length", () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText("Trial length (days)"), {
      target: { value: "1.5" },
    });

    expect(screen.getByText("Create sandbox").closest("button")?.disabled).toBe(
      true,
    );
    expect(
      screen.getByLabelText("Trial length (days)").getAttribute("step"),
    ).toBe("1");
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
      data: { tenantId: "t1", seededAccounts: [] },
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

  // Issue #891: Show close button when sandbox provisioning poll hits a network error
  it("shows a close button when the provisioning poll hits a network error, and closing refreshes the list because the sandbox may exist (#995)", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockRejectedValueOnce(
      new Error("Network connection lost"),
    );
    const { onClose, onCreated } = renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("Network connection lost")).toBeTruthy();
      expect(screen.getByText("Close")).toBeTruthy();
      expect(screen.getByLabelText("Close")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Close"));
    // A job was started, so the sandbox may exist even though polling lost track of it:
    // refresh the list instead of just closing.
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("warns that the credentials are shown only once when the poll fails while the job may still be running (#995)", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockRejectedValueOnce(new Error("Network timeout"));
    renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => screen.getByText("Network timeout"));

    expect(screen.getByText(/shown only once/i)).toBeTruthy();
  });

  it("does not warn about credentials, and just closes, when provisioning itself failed (#995)", async () => {
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
    const { onClose, onCreated } = renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => screen.getByText("SANDBOX_ORG_CREATE_FAILED"));
    expect(screen.queryByText(/shown only once/i)).toBeNull();

    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("says the credentials could not be loaded, and refreshes the list on close, when the handover fetch fails after completion (#995)", async () => {
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
    mockFetchWithAuth.mockRejectedValueOnce(new Error("handover 500"));
    const { onClose, onCreated } = renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText(/credentials could not be loaded/i)).toBeTruthy();
    });
    expect(screen.queryByText("Sandbox ready")).toBeNull();

    fireEvent.click(screen.getByText("Close"));
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clears the network error message when a subsequent poll succeeds", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockRejectedValueOnce(
      new Error("Temporary network glitch"),
    );
    mockFetchWithAuth.mockResolvedValue({
      data: {
        status: "running",
        currentStep: "configuring org",
        completedSteps: 3,
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
      expect(screen.getByText("Temporary network glitch")).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(2_000);

    await waitFor(() => {
      expect(screen.getByText("configuring org")).toBeTruthy();
      expect(screen.queryByText("Temporary network glitch")).toBeNull();
    });
  });

  // Issue #892: Add copy-to-clipboard button for sandbox handover credentials
  it("copies credentials to clipboard with tab-separated values on copy button click", async () => {
    await showHandover();

    const copyBtn = screen.getByRole("button", { name: "Copy credentials" });
    expect(copyBtn).toBeTruthy();

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        "Username\tEmail\tRole\tPassword\n" +
          "admin.user\tadmin@example.com\tadmin\tOw-admin-9!\n" +
          "olivia.smith\tolivia.smith@example.com\tuser\tOw-olivia-9!",
      );
      expect(screen.getByText("Copied!")).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(2_000);

    await waitFor(() => {
      expect(screen.getByText("Copy credentials")).toBeTruthy();
    });
  });

  it("dismisses the modal using the top-right close button when provisioning poll hits a network error", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: { jobId: "job-1" } });
    mockFetchWithAuth.mockRejectedValueOnce(new Error("Network timeout"));
    const { onCreated } = renderModal();
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByText("Create sandbox"));

    await waitFor(() => {
      expect(screen.getByText("Network timeout")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onCreated).toHaveBeenCalled();
  });

  it("announces a successful copy to assistive technology (#995)", async () => {
    await showHandover();
    // The live region exists before anything is announced, empty.
    expect(screen.getByRole("status").textContent).toBe("");

    fireEvent.click(screen.getByText("Copy credentials"));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/copied/i);
    });
  });

  it("resets copied countdown if copy credentials is clicked again before 2s elapses", async () => {
    await showHandover();

    const copyBtn = screen.getByRole("button", { name: "Copy credentials" });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(screen.getByText("Copied!")).toBeTruthy();
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(screen.getByText("Copied!")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copied!" }));

    await vi.advanceTimersByTimeAsync(1_500);
    // 2.5s since first click, but 1.5s since second click, so still copied
    expect(screen.getByText("Copied!")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(600);
    // 2.1s since second click, now reverted
    expect(screen.getByText("Copy credentials")).toBeTruthy();
  });

  it("shows an inline alert when copying credentials to clipboard fails", async () => {
    mockWriteText.mockRejectedValueOnce(new Error("Permission denied"));
    await showHandover();

    fireEvent.click(screen.getByRole("button", { name: "Copy credentials" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(
        /Could not copy credentials/,
      );
    });
  });

  it("clears download error when copy credentials is clicked, and clears copy error when download is clicked", async () => {
    mockDownloadHandoverCsv.mockImplementationOnce(() => {
      throw new Error("Blob error");
    });
    await showHandover();

    // Trigger download error
    fireEvent.click(screen.getByText("Download CSV"));
    expect(screen.getByText(/Could not create the CSV/)).toBeTruthy();

    // Clicking copy credentials clears the download error
    fireEvent.click(screen.getByText("Copy credentials"));
    await waitFor(() => {
      expect(screen.queryByText(/Could not create the CSV/)).toBeNull();
    });

    await vi.advanceTimersByTimeAsync(2_000);

    // Make copy fail
    mockWriteText.mockRejectedValueOnce(new Error("Copy denied"));
    fireEvent.click(screen.getByText("Copy credentials"));
    await waitFor(() => {
      expect(screen.getByText(/Could not copy credentials/)).toBeTruthy();
    });

    // Clicking download clears the copy error
    mockDownloadHandoverCsv.mockImplementationOnce(() => undefined);
    fireEvent.click(screen.getByText("Download CSV"));
    expect(screen.queryByText(/Could not copy credentials/)).toBeNull();
  });
});
