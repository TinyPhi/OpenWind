import { describe, it, expect, vi, afterEach } from "vitest";
import "../../i18n.js";
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

const { EditBrandingDialog } = await import("./edit-branding-dialog.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const SAVED_LOGO = "data:image/png;base64,iVBORw0KGgo=";

function renderDialog(logo: string | null = null): {
  onClose: ReturnType<typeof vi.fn>;
  onSaved: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <EditBrandingDialog
      open
      tenantId={TENANT_ID}
      tenantName="Acme Demo"
      logo={logo}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onClose, onSaved };
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}

function logoInput(): HTMLInputElement {
  return screen.getByLabelText("Logo") as HTMLInputElement;
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: "Save" });
}

function pick(file: File): void {
  fireEvent.change(logoInput(), { target: { files: [file] } });
}

describe("EditBrandingDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts with the current name, nothing to save, and an initials preview", () => {
    renderDialog();
    expect(nameInput().value).toBe("Acme Demo");
    expect(saveButton().hasAttribute("disabled")).toBe(true);
    const preview = screen.getByLabelText("Header preview");
    expect(preview.textContent).toContain("AD");
    expect(preview.textContent).toContain("Acme Demo");
  });

  it("previews initials of the edited name and sends only the changed name", async () => {
    const { onSaved } = renderDialog();
    fireEvent.change(nameInput(), { target: { value: "  Zed Corp  " } });
    expect(screen.getByLabelText("Header preview").textContent).toContain("ZC");

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      `/api/platform-admin/sandboxes/${TENANT_ID}/branding`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Zed Corp" }),
      }),
    );
  });

  it("reads a chosen image into the preview and sends it as the logo", async () => {
    const { onSaved } = renderDialog();
    pick(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
        type: "image/png",
      }),
    );

    await waitFor(() =>
      expect(saveButton().hasAttribute("disabled")).toBe(false),
    );
    expect(
      screen.getByLabelText("Header preview").querySelector("img"),
    ).not.toBeNull();

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [, options] = mockFetchWithAuth.mock.calls[0] ?? [];
    const body = JSON.parse(String(options?.body)) as {
      name?: string;
      logo?: string;
    };
    expect(body.name).toBeUndefined();
    expect(body.logo).toMatch(/^data:image\/png;base64,/);
  });

  it.each([
    [
      "an SVG",
      new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
      /PNG, JPEG or WebP/,
    ],
    [
      "a file over 100 KB",
      new File([new Uint8Array(100 * 1024 + 1)], "big.png", {
        type: "image/png",
      }),
      /100 KB or smaller/,
    ],
  ])(
    "refuses %s with a reason and keeps saving disabled",
    (_label, file, message) => {
      renderDialog();
      pick(file);

      expect(screen.getByRole("alert").textContent).toMatch(message);
      expect(saveButton().hasAttribute("disabled")).toBe(true);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    },
  );

  it("removes the saved logo by sending logo null", async () => {
    const { onSaved } = renderDialog(SAVED_LOGO);
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));

    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ logo: null }) }),
    );
  });

  it("lets the admin undo a removal before saving", () => {
    renderDialog(SAVED_LOGO);
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    expect(screen.queryByRole("button", { name: "Remove logo" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep current logo" }));

    expect(screen.getByRole("button", { name: "Remove logo" })).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("drops a newly picked image when Remove logo is pressed, back to no logo", async () => {
    renderDialog();
    pick(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
        type: "image/png",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove logo" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));

    expect(screen.queryByRole("button", { name: "Remove logo" })).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  it("offers no Remove logo when there is no logo", () => {
    renderDialog();
    expect(screen.queryByRole("button", { name: "Remove logo" })).toBeNull();
  });

  it.each(["", "   ", "x".repeat(101)])(
    "disables saving for an invalid name of length %#",
    (value) => {
      renderDialog();
      fireEvent.change(nameInput(), { target: { value } });
      expect(saveButton().hasAttribute("disabled")).toBe(true);
    },
  );

  it("alerts and stays open when the request fails", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("No such sandbox"));
    const { onSaved } = renderDialog();
    fireEvent.change(nameInput(), { target: { value: "Other" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(mockShowAlert).toHaveBeenCalledWith("No such sandbox"),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("calls onClose on Cancel without sending anything", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
