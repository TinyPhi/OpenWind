import "../i18n.js";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api.js", () => ({
  API_URL: "",
  fetchWithAuth: vi.fn(),
}));

vi.mock("./org-directory.js", () => ({
  OrgChartPanel: () => <div>org-chart-panel</div>,
}));

vi.mock("../components/toast.js", () => ({ showToast: vi.fn() }));
vi.mock("../components/global-alert-dialog.js", () => ({ showAlert: vi.fn() }));

vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: vi.fn().mockResolvedValue({ profile: {} }),
  },
}));

const api = await import("../lib/api.js");
const fetchWithAuth = vi.mocked(api.fetchWithAuth);
const { UsersPage } = await import("./users.js");
const { userManager } = await import("../authProvider.js");
const { showToast } = await import("../components/toast.js");
const { showAlert } = await import("../components/global-alert-dialog.js");

beforeEach(() => {
  fetchWithAuth.mockReset();
});

afterEach(() => cleanup());

describe("UsersPage", () => {
  it.each(["", "   "])(
    "renders the fallback initial when a user's display name is %j",
    async (displayName) => {
      fetchWithAuth.mockResolvedValue({
        data: [
          {
            userId: "user-1",
            displayName,
            email: "user@example.com",
            loginName: "user",
            roles: [],
          },
        ],
      });

      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText("U")).not.toBeNull());
    },
  );

  it("opens and closes the org chart modal from the header button", () => {
    fetchWithAuth.mockResolvedValue({ data: [] });

    render(<UsersPage />);

    expect(screen.queryByText("org-chart-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View org chart" }));
    expect(screen.getByRole("dialog", { name: "Org chart" })).not.toBeNull();
    expect(screen.getByText("org-chart-panel")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("org-chart-panel")).toBeNull();
  });
});

describe("UsersPage — erase a user (#728)", () => {
  const ME = {
    userId: "me",
    displayName: "Admin Me",
    email: "me@example.com",
    loginName: "me",
    roles: ["admin"],
  };
  const RAVI = {
    userId: "user-2",
    displayName: "Ravi Kumar",
    email: "ravi@example.com",
    loginName: "ravi",
    roles: ["user"],
  };

  function signInAs(sub: string, roles: string[]): void {
    vi.mocked(userManager.getUser).mockResolvedValue({
      profile: {
        sub,
        "urn:zitadel:iam:org:project:roles": Object.fromEntries(
          roles.map((r) => [r, {}]),
        ),
      },
    } as never);
  }

  function apiAnswers(deleteReply: unknown | Error): void {
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return deleteReply instanceof Error
          ? Promise.reject(deleteReply)
          : Promise.resolve(deleteReply);
      }
      expect(url).toBe("/users");
      return Promise.resolve({ data: [ME, RAVI] });
    });
  }

  async function openEraseFor(name: string): Promise<void> {
    fireEvent.click(
      await screen.findByRole("button", { name: `Erase ${name}` }),
    );
    await screen.findByRole("alertdialog");
  }

  beforeEach(() => {
    vi.mocked(showToast).mockClear();
    vi.mocked(showAlert).mockClear();
  });

  afterEach(() => {
    vi.mocked(userManager.getUser).mockResolvedValue({ profile: {} } as never);
  });

  it("shows Erase to an admin on other people's rows, never on their own", async () => {
    signInAs("me", ["admin"]);
    apiAnswers({ success: true });
    render(<UsersPage />);
    expect(
      await screen.findByRole("button", { name: "Erase Ravi Kumar" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Erase Admin Me" })).toBeNull();
  });

  it("shows no Erase button to someone who is not an admin", async () => {
    signInAs("someone", ["user"]);
    apiAnswers({ success: true });
    render(<UsersPage />);
    await screen.findByText("Ravi Kumar");
    expect(screen.queryByRole("button", { name: /^Erase / })).toBeNull();
  });

  it("asks for the name first, erases only after it is typed, and shows the Superset result", async () => {
    signInAs("me", ["admin"]);
    apiAnswers({
      success: true,
      superset: {
        status: "queued",
        switchIgnored: false,
        message: "The user's Superset data is being erased.",
      },
    });
    render(<UsersPage />);
    await openEraseFor("Ravi Kumar");

    expect(screen.getByText("Erase this user?")).toBeDefined();
    const erase = screen.getByRole("button", { name: "Erase" });
    expect(erase.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Type Ravi Kumar to confirm"), {
      target: { value: "Ravi Kumar" },
    });
    expect(erase.hasAttribute("disabled")).toBe(false);
    fireEvent.click(erase);

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith("/users/user-2", {
        method: "DELETE",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Ravi Kumar")).toBeNull());
    expect(showToast).toHaveBeenCalledWith({
      title: "Ravi Kumar was erased.",
      message: "The user's Superset data is being erased.",
      tone: "success",
    });
  });

  it("warns in the toast when Superset data was not erased", async () => {
    signInAs("me", ["admin"]);
    apiAnswers({
      success: true,
      superset: {
        status: "disabled",
        switchIgnored: false,
        message:
          "Superset data was not erased because Superset erasure is disabled.",
      },
    });
    render(<UsersPage />);
    await openEraseFor("Ravi Kumar");
    fireEvent.change(screen.getByLabelText("Type Ravi Kumar to confirm"), {
      target: { value: "Ravi Kumar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        title: "Ravi Kumar was erased.",
        message:
          "Superset data was not erased because Superset erasure is disabled.",
        tone: "warning",
      }),
    );
  });

  it("still confirms the erasure when the API sends no Superset result", async () => {
    signInAs("me", ["admin"]);
    apiAnswers({ success: true });
    render(<UsersPage />);
    await openEraseFor("Ravi Kumar");
    fireEvent.change(screen.getByLabelText("Type Ravi Kumar to confirm"), {
      target: { value: "Ravi Kumar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        title: "Ravi Kumar was erased.",
        message: undefined,
        tone: "success",
      }),
    );
  });

  it("keeps the user and says so when the erasure fails", async () => {
    signInAs("me", ["admin"]);
    apiAnswers(new Error("Request failed (500)"));
    render(<UsersPage />);
    await openEraseFor("Ravi Kumar");
    fireEvent.change(screen.getByLabelText("Type Ravi Kumar to confirm"), {
      target: { value: "Ravi Kumar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    await waitFor(() =>
      expect(showAlert).toHaveBeenCalledWith(
        "Ravi Kumar was not erased: Request failed (500).",
        "Erase failed",
      ),
    );
    expect(screen.getByText("Ravi Kumar")).toBeDefined();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("says the erase is incomplete, and keeps the user, when only the sign-in removal failed", async () => {
    signInAs("me", ["admin"]);
    apiAnswers(
      Object.assign(new Error("sign-in not removed"), {
        status: 502,
        code: "SIGN_IN_NOT_REMOVED",
      }),
    );
    render(<UsersPage />);
    await openEraseFor("Ravi Kumar");
    fireEvent.change(screen.getByLabelText("Type Ravi Kumar to confirm"), {
      target: { value: "Ravi Kumar" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    await waitFor(() =>
      expect(showAlert).toHaveBeenCalledWith(
        "Ravi Kumar's data was erased, but their sign-in could not be removed, so they can still sign in. Erase them again to retry.",
        "Erase incomplete",
      ),
    );
    expect(screen.getByText("Ravi Kumar")).toBeDefined();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("erases nothing when the admin cancels", async () => {
    signInAs("me", ["admin"]);
    apiAnswers({ success: true });
    render(<UsersPage />);
    await openEraseFor("Ravi Kumar");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(
      fetchWithAuth.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });
});
