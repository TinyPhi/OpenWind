import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

const mockFetchWithAuth = vi.fn(
  (_url: string, _options?: RequestInit): Promise<unknown> =>
    Promise.resolve({ data: {} }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, options?: RequestInit) =>
    mockFetchWithAuth(url, options),
  API_URL: "/api",
}));

const { PlatformAdminMfa } = await import("./mfa.js");

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <PlatformAdminMfa />
    </MemoryRouter>,
  );
}

describe("PlatformAdminMfa", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("requests a code on mount", async () => {
    mockFetchWithAuth.mockResolvedValue({ data: { sent: true } });
    renderPage();

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/platform-admin/mfa/request",
        { method: "POST" },
      );
    });
  });

  it("shows an inline error when the code request fails, without blocking the form", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("could not send"));
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("verifies the entered code and navigates to the dashboard on success", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ data: { sent: true } }) // request
      .mockResolvedValueOnce({ data: { verified: true } }); // verify
    renderPage();

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/platform-admin/mfa/verify",
        { method: "POST", body: JSON.stringify({ code: "123456" }) },
      );
      expect(navigateSpy).toHaveBeenCalledWith("/platform-admin/dashboard", {
        replace: true,
      });
    });
  });

  it("shows an inline error on an invalid code without navigating", async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ data: { sent: true } }) // request
      .mockRejectedValueOnce(new Error("Invalid or expired code")); // verify
    renderPage();

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() => {
      expect(screen.getByText("Invalid or expired code")).toBeTruthy();
    });
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("strips non-digit characters from the code input", () => {
    mockFetchWithAuth.mockResolvedValue({ data: { sent: true } });
    renderPage();

    const input = screen.getByLabelText(
      "Verification code",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12a3b4c" } });

    expect(input.value).toBe("1234");
  });
});
