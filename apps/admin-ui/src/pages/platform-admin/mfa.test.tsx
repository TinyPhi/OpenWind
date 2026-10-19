import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

// The code flow itself is covered by otp-verification.test.tsx; this page only places it.
let capturedOnVerified: (() => void) | null = null;
vi.mock("./otp-verification.js", () => ({
  OtpVerification: ({ onVerified }: { onVerified: () => void }) => {
    capturedOnVerified = onVerified;
    return <div data-testid="otp-flow" />;
  },
}));

const mockSignOut = vi.fn<() => Promise<string | undefined>>();
vi.mock("./sign-out.js", () => ({
  signOutPlatformAdmin: () => mockSignOut(),
}));

const { PlatformAdminMfa } = await import("./mfa.js");

function renderPage(): void {
  render(
    <MemoryRouter>
      <PlatformAdminMfa />
    </MemoryRouter>,
  );
}

describe("PlatformAdminMfa", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    capturedOnVerified = null;
  });

  it("explains that every sign-in needs a code and shows the code flow", () => {
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Verify it's you" }),
    ).toBeTruthy();
    expect(screen.getByText(/every time you log in/)).toBeTruthy();
    expect(screen.getByTestId("otp-flow")).toBeTruthy();
  });

  it("goes to the dashboard once the code is verified", () => {
    renderPage();

    capturedOnVerified?.();

    expect(navigateSpy).toHaveBeenCalledWith("/platform-admin/dashboard", {
      replace: true,
    });
  });

  it("signs out (ending the MFA session) from the page", async () => {
    mockSignOut.mockReturnValueOnce(new Promise(() => {})); // still redirecting
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
    expect(
      (
        screen.getByRole("button", {
          name: "Signing out…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("re-enables Sign out if signing out fails", async () => {
    mockSignOut.mockRejectedValueOnce(new Error("offline"));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeTruthy();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
