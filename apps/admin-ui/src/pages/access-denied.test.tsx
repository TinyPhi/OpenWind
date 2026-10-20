import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "../i18n.js";

const mockGetUser = vi.fn<() => Promise<{ id_token?: string } | null>>();
const mockClearStaleState = vi.fn((): Promise<void> => Promise.resolve());
const mockSignoutRedirect = vi.fn(
  (_args?: unknown): Promise<void> => Promise.resolve(),
);
const mockRemoveUser = vi.fn((): Promise<void> => Promise.resolve());
vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: () => mockGetUser(),
    clearStaleState: () => mockClearStaleState(),
    signoutRedirect: (args?: unknown) => mockSignoutRedirect(args),
    removeUser: () => mockRemoveUser(),
  },
}));

const { AccessDenied } = await import("./access-denied.js");

const mockReplace = vi.fn((_url: string): void => {});
const originalLocation = window.location;

function renderAt(reason: string | null): void {
  const query = reason === null ? "" : `?reason=${reason}`;
  render(
    <MemoryRouter initialEntries={[`/access-denied${query}`]}>
      <AccessDenied />
    </MemoryRouter>,
  );
}

async function tick(seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

// docs/specs/tenant-access-gate.md R4.
describe("AccessDenied", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ id_token: "id-tok" });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, replace: (u: string) => mockReplace(u) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it.each([
    ["TENANT_NOT_FOUND", "Your organisation isn't set up on this server."],
    ["TENANT_SUSPENDED", "This organisation's access has ended or is blocked."],
    [
      "TENANT_TRIAL_EXPIRED",
      "This organisation's access has ended or is blocked.",
    ],
    [
      "NO_ROLE",
      "Your account hasn't been given access to OpenWind. Ask your organisation's admin.",
    ],
  ])("explains %s", (reason, message) => {
    renderAt(reason);
    expect(screen.getByText(message)).toBeDefined();
    expect(screen.getByText("You can't use OpenWind here")).toBeDefined();
  });

  it("falls back to the no-tenant message for an unknown reason", () => {
    renderAt("SOMETHING_ELSE");
    expect(
      screen.getByText("Your organisation isn't set up on this server."),
    ).toBeDefined();
  });

  it("counts down from 5, then signs out at Zitadel too", async () => {
    renderAt("NO_ROLE");
    expect(screen.getByText("Signing you out in 5 seconds…")).toBeDefined();

    await tick(1);
    expect(screen.getByText("Signing you out in 4 seconds…")).toBeDefined();
    expect(mockSignoutRedirect).not.toHaveBeenCalled();

    await tick(4);
    expect(mockSignoutRedirect).toHaveBeenCalledTimes(1);
    expect(mockSignoutRedirect).toHaveBeenCalledWith({
      id_token_hint: "id-tok",
    });
    expect(screen.getByText("Signing you out…")).toBeDefined();
  });

  it("signs out at once on 'Sign out now', only once", async () => {
    renderAt("TENANT_NOT_FOUND");
    fireEvent.click(screen.getByRole("button", { name: "Sign out now" }));
    await tick(6);
    expect(mockSignoutRedirect).toHaveBeenCalledTimes(1);
  });

  it("falls back to a local sign-out and the login page when Zitadel can't be reached", async () => {
    mockSignoutRedirect.mockRejectedValueOnce(new Error("network"));
    renderAt("TENANT_NOT_FOUND");
    fireEvent.click(screen.getByRole("button", { name: "Sign out now" }));
    await tick(1);
    expect(mockRemoveUser).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/login");
  });

  it("links to support with an access-issue subject", () => {
    renderAt("NO_ROLE");
    const link = screen.getByRole("link", {
      name: "Think this is a mistake? Contact us",
    });
    expect(link.getAttribute("href")).toBe(
      "mailto:info@rokkalabs.com?subject=OpenWind+access+issue",
    );
  });
});
