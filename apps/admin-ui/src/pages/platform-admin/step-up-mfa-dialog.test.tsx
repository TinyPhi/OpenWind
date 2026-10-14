import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";

interface FetchError extends Error {
  status?: number;
  meta?: { retryAfterSeconds?: unknown };
}

const mockFetchWithAuth = vi.fn(
  (_url: string, _options?: RequestInit): Promise<unknown> =>
    Promise.resolve({ data: { sent: true, resendAfterSeconds: 30 } }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, options?: RequestInit) =>
    mockFetchWithAuth(url, options),
  API_URL: "/api",
}));

const { StepUpMfaDialog } = await import("./step-up-mfa-dialog.js");

function renderDialog(
  props: Partial<{ onVerified: () => void; onCancel: () => void }> = {},
): { onVerified: () => void; onCancel: () => void } {
  const onVerified = props.onVerified ?? vi.fn();
  const onCancel = props.onCancel ?? vi.fn();
  render(
    <StepUpMfaDialog open={true} onVerified={onVerified} onCancel={onCancel} />,
  );
  return { onVerified, onCancel };
}

function type(code: string): void {
  fireEvent.change(screen.getByLabelText("Verification code"), {
    target: { value: code },
  });
}

const REQUEST_URL = "/api/platform-admin/mfa/request";
const VERIFY_URL = "/api/platform-admin/mfa/verify";

describe("StepUpMfaDialog (#865)", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockImplementation((url) =>
      Promise.resolve(
        url === REQUEST_URL
          ? { data: { sent: true, resendAfterSeconds: 30 } }
          : { data: { verified: true } },
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("requests a code once when it opens", async () => {
    renderDialog();
    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(REQUEST_URL, {
        method: "POST",
      });
    });
    expect(
      mockFetchWithAuth.mock.calls.filter((c) => c[0] === REQUEST_URL),
    ).toHaveLength(1);
  });

  it("keeps Verify disabled until six digits are entered, and strips non-digits", () => {
    renderDialog();
    const verify = screen.getByRole("button", { name: "Verify" });
    expect((verify as HTMLButtonElement).disabled).toBe(true);
    type("12ab34");
    expect(
      (screen.getByLabelText("Verification code") as HTMLInputElement).value,
    ).toBe("1234");
    expect((verify as HTMLButtonElement).disabled).toBe(true);
    type("123456");
    expect((verify as HTMLButtonElement).disabled).toBe(false);
  });

  it("verifies the code and calls onVerified", async () => {
    const { onVerified } = renderDialog();
    type("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
    expect(mockFetchWithAuth).toHaveBeenCalledWith(VERIFY_URL, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
  });

  it("shows the server's message and clears the field on a wrong code, without calling onVerified", async () => {
    mockFetchWithAuth.mockImplementation((url) => {
      if (url === VERIFY_URL) {
        const err: FetchError = new Error("Incorrect or expired code");
        err.status = 422;
        return Promise.reject(err);
      }
      return Promise.resolve({ data: { sent: true, resendAfterSeconds: 30 } });
    });
    const { onVerified } = renderDialog();
    type("000000");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(screen.getByText("Incorrect or expired code")).toBeTruthy();
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Verification code") as HTMLInputElement).value,
    ).toBe("");
  });

  it("starts the resend countdown from the server's configured cooldown", async () => {
    renderDialog();
    const resend = await screen.findByRole("button", {
      name: /Resend code \(30s\)/,
    });
    expect((resend as HTMLButtonElement).disabled).toBe(true);
  });

  it("counts down and re-enables Resend when the cooldown ends", async () => {
    vi.useFakeTimers();
    mockFetchWithAuth.mockResolvedValue({
      data: { sent: true, resendAfterSeconds: 2 },
    });
    renderDialog();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByRole("button", { name: /Resend code \(2s\)/ }),
    ).toBeTruthy();

    // One tick per act: each tick re-renders, which re-arms the next timeout.
    for (let i = 0; i < 2; i++) {
      await act(() => {
        vi.advanceTimersByTime(1000);
        return Promise.resolve();
      });
    }

    const resend = screen.getByRole("button", { name: "Resend code" });
    expect((resend as HTMLButtonElement).disabled).toBe(false);
  });

  it("adopts the wait from a 429 (a code was just sent) instead of showing an error", async () => {
    mockFetchWithAuth.mockImplementation((url) => {
      if (url === REQUEST_URL) {
        const err: FetchError = new Error("A code was sent recently");
        err.status = 429;
        err.meta = { retryAfterSeconds: 12 };
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });
    renderDialog();

    await screen.findByRole("button", { name: /Resend code \(12s\)/ });
    expect(screen.queryByText("A code was sent recently")).toBeNull();
  });

  it("shows a send failure inline", async () => {
    mockFetchWithAuth.mockImplementation((url) => {
      if (url === REQUEST_URL) {
        const err: FetchError = new Error("Could not send verification code");
        err.status = 502;
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });
    renderDialog();

    await screen.findByText("Could not send verification code");
  });

  it("Cancel calls onCancel and does not verify", () => {
    const { onCancel, onVerified } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
  });
});
