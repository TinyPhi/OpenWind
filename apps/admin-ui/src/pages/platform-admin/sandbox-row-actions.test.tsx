import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

interface FetchError extends Error {
  status?: number;
}

const mockFetchWithAuth = vi.fn(
  (_url: string, _options?: RequestInit): Promise<unknown> =>
    Promise.resolve({ data: {} }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, options?: RequestInit) =>
    mockFetchWithAuth(url, options),
  API_URL: "/api",
}));

const mockShowAlert = vi.fn((_message: string): void => {});
vi.mock("../../components/global-alert-dialog.js", () => ({
  showAlert: (message: string) => mockShowAlert(message),
}));

const { SandboxRowActions } = await import("./sandbox-row-actions.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function renderComponent(onDone: () => void = vi.fn()): () => void {
  render(
    <SandboxRowActions
      tenantId={TENANT_ID}
      tenantName="Acme Sandbox"
      onDone={onDone}
    />,
  );
  return onDone;
}

/** The dialog's confirm button shares its label with the row button that opened it. */
function getConfirmButton(label: string): HTMLElement {
  const matches = screen.getAllByText(label);
  const confirmButton = matches[matches.length - 1];
  expect(confirmButton).toBeTruthy();
  return confirmButton as HTMLElement;
}

describe("SandboxRowActions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a confirmation dialog before resetting", () => {
    renderComponent();
    fireEvent.click(screen.getByText("Reset"));

    expect(screen.getByText("Reset this sandbox?")).toBeTruthy();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("calls the reset endpoint and onDone after confirming", async () => {
    const onDone = renderComponent();
    fireEvent.click(screen.getByText("Reset"));
    fireEvent.click(getConfirmButton("Reset"));

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        `/api/platform-admin/sandboxes/${TENANT_ID}/reset`,
        { method: "POST" },
      );
      expect(onDone).toHaveBeenCalled();
    });
  });

  it("shows a confirmation dialog before deleting, mentioning the Zitadel org", () => {
    renderComponent();
    fireEvent.click(screen.getByText("Delete"));

    expect(screen.getByText("Delete this sandbox?")).toBeTruthy();
    expect(screen.getByText(/Zitadel organization/)).toBeTruthy();
  });

  it("calls the delete endpoint after confirming", async () => {
    renderComponent();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(getConfirmButton("Delete"));

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        `/api/platform-admin/sandboxes/${TENANT_ID}/delete`,
        { method: "POST" },
      );
    });
  });

  it("shows a specific alert for a 409 (already in progress) response", async () => {
    const err: FetchError = new Error("conflict");
    err.status = 409;
    mockFetchWithAuth.mockRejectedValue(err);
    renderComponent();
    fireEvent.click(screen.getByText("Reset"));
    fireEvent.click(getConfirmButton("Reset"));

    await waitFor(() => {
      expect(mockShowAlert).toHaveBeenCalledWith(
        "Already in progress for this sandbox — try again shortly.",
      );
    });
  });

  it("shows the raw error message for a non-409 failure", async () => {
    mockFetchWithAuth.mockRejectedValue(new Error("Could not reach server"));
    renderComponent();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(getConfirmButton("Delete"));

    await waitFor(() => {
      expect(mockShowAlert).toHaveBeenCalledWith("Could not reach server");
    });
  });

  it("cancelling the dialog does not call the endpoint", () => {
    renderComponent();
    fireEvent.click(screen.getByText("Reset"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByText("Reset this sandbox?")).toBeNull();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("disables both action buttons while a request for this row is in flight", async () => {
    let resolveRequest!: () => void;
    mockFetchWithAuth.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = () => resolve({ data: {} });
      }),
    );
    renderComponent();
    fireEvent.click(screen.getByText("Reset"));
    fireEvent.click(getConfirmButton("Reset"));

    await waitFor(() => {
      expect(screen.getByText("Reset")).toHaveProperty("disabled", true);
      expect(screen.getByText("Delete")).toHaveProperty("disabled", true);
    });

    resolveRequest();
  });
});
