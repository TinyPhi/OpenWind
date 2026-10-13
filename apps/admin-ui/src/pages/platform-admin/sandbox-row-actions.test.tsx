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

// Shallow-mocked: change-trial-dialog.test.tsx covers the dialog itself.
vi.mock("./change-trial-dialog.js", () => ({
  ChangeTrialDialog: (props: {
    onSaved: () => void;
    trialEndsAt: string | null;
  }) => (
    <div>
      Trial dialog ({props.trialEndsAt ?? "none"})
      <button type="button" onClick={props.onSaved}>
        Save trial
      </button>
    </div>
  ),
}));

const { SandboxRowActions } = await import("./sandbox-row-actions.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function renderComponent(onDone: () => void = vi.fn()): () => void {
  render(
    <SandboxRowActions
      tenantId={TENANT_ID}
      tenantName="Acme Sandbox"
      trialEndsAt="2026-12-01T00:00:00.000Z"
      onDone={onDone}
    />,
  );
  return onDone;
}

function choose(item: "Reset" | "Delete" | "Change trial"): void {
  fireEvent.click(screen.getByLabelText("Actions for Acme Sandbox"));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** The dialog's confirm button shares its label with the menu item that opened it. */
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
    choose("Reset");

    expect(screen.getByText("Reset this sandbox?")).toBeTruthy();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("calls the reset endpoint and onDone after confirming", async () => {
    const onDone = renderComponent();
    choose("Reset");
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
    choose("Delete");

    expect(screen.getByText("Delete this sandbox?")).toBeTruthy();
    expect(screen.getByText(/Zitadel organization/)).toBeTruthy();
  });

  it("calls the delete endpoint after confirming", async () => {
    renderComponent();
    choose("Delete");
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
    choose("Reset");
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
    choose("Delete");
    fireEvent.click(getConfirmButton("Delete"));

    await waitFor(() => {
      expect(mockShowAlert).toHaveBeenCalledWith("Could not reach server");
    });
  });

  it("cancelling the dialog does not call the endpoint", () => {
    renderComponent();
    choose("Reset");
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.queryByText("Reset this sandbox?")).toBeNull();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it("keeps actions inside a closed menu until it is opened", () => {
    renderComponent();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByLabelText("Actions for Acme Sandbox"));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual(
      ["Reset", "Change trial", "Delete"],
    );
  });

  it("renders the open menu outside the row, on document.body", () => {
    const { container } = render(
      <div className="pa-table-wrap">
        <SandboxRowActions
          tenantId={TENANT_ID}
          tenantName="Acme Sandbox"
          trialEndsAt={null}
          onDone={vi.fn()}
        />
      </div>,
    );
    fireEvent.click(screen.getByLabelText("Actions for Acme Sandbox"));

    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
  });

  it("opens below the button when there is room, above it near the viewport bottom", () => {
    renderComponent();
    const button = screen.getByLabelText("Actions for Acme Sandbox");
    const rectAt = (top: number): DOMRect =>
      // Only the edges menuPositionFor reads matter here.
      ({ top, bottom: top + 32, right: 500, left: 468 }) as DOMRect;

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(rectAt(100));
    fireEvent.click(button);
    expect(screen.getByRole("menu").style.top).toBe("138px");
    fireEvent.click(button);

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
      rectAt(window.innerHeight - 40),
    );
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("auto");
    expect(menu.style.bottom).toBe("46px");
  });

  it("closes the menu when anything scrolls", () => {
    renderComponent();
    fireEvent.click(screen.getByLabelText("Actions for Acme Sandbox"));
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu on Escape", () => {
    renderComponent();
    fireEvent.click(screen.getByLabelText("Actions for Acme Sandbox"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the trial dialog with the current end and calls onDone after saving", () => {
    const onDone = renderComponent();
    choose("Change trial");
    expect(
      screen.getByText("Trial dialog (2026-12-01T00:00:00.000Z)"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Save trial"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Trial dialog/)).toBeNull();
  });

  it("disables the actions menu while a request for this row is in flight", async () => {
    let resolveRequest!: () => void;
    mockFetchWithAuth.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = () => resolve({ data: {} });
      }),
    );
    renderComponent();
    choose("Reset");
    fireEvent.click(getConfirmButton("Reset"));

    await waitFor(() => {
      expect(screen.getByLabelText("Actions for Acme Sandbox")).toHaveProperty(
        "disabled",
        true,
      );
    });

    resolveRequest();
  });
});
