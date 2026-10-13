import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
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

const mockShowAlert = vi.fn((_message: string): void => {});
vi.mock("../../components/global-alert-dialog.js", () => ({
  showAlert: (message: string) => mockShowAlert(message),
}));

const { ChangeTrialDialog } = await import("./change-trial-dialog.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;

function renderDialog(trialEndsAt: string | null): {
  onClose: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ChangeTrialDialog
      open
      tenantId={TENANT_ID}
      tenantName="Acme Sandbox"
      trialEndsAt={trialEndsAt}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onClose, onSaved };
}

function daysInput(): HTMLElement {
  return screen.getByLabelText("New trial length (days from now)");
}

describe("ChangeTrialDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the current end date for an active trial", () => {
    renderDialog(new Date(Date.now() + 5 * DAY).toISOString());
    expect(screen.getByText(/trial ends/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("offers reactivation for an expired trial", () => {
    renderDialog(new Date(Date.now() - DAY).toISOString());
    expect(screen.getByText(/expired on/)).toBeTruthy();
    expect(screen.getByText(/reactivates the sandbox/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeTruthy();
  });

  it("posts the chosen day count and reports success", async () => {
    const { onSaved } = renderDialog(null);
    fireEvent.change(daysInput(), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      `/api/platform-admin/sandboxes/${TENANT_ID}/trial`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ trialDays: 30 }),
      }),
    );
  });

  it.each(["0", "366", "2.5", ""])(
    "disables saving for an invalid day count %s",
    (value) => {
      renderDialog(null);
      fireEvent.change(daysInput(), { target: { value } });
      expect(
        screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getByText(/whole number from 1 to 365/)).toBeTruthy();
    },
  );

  it("alerts and stays open when the request fails", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("No such sandbox"));
    const { onSaved } = renderDialog(null);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith("No such sandbox"),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("calls onClose on Cancel without posting", () => {
    const { onClose } = renderDialog(null);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
