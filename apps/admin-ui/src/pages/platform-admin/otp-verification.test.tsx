import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";

type FetchError = Error & {
  status?: number;
  code?: string;
  meta?: Record<string, unknown> | undefined;
};

function apiError(
  status: number,
  code: string,
  message: string,
  meta?: Record<string, unknown>,
): FetchError {
  return Object.assign(new Error(message), { status, code, meta });
}

const mockFetchWithAuth =
  vi.fn<(url: string, options?: RequestInit) => Promise<unknown>>();
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string, options?: RequestInit) =>
    mockFetchWithAuth(url, options),
  API_URL: "/api",
}));

const mockSetSession = vi.fn<(token: string) => void>();
vi.mock("../../lib/platform-admin-mfa-session.js", () => ({
  setPlatformAdminMfaSession: (token: string) => mockSetSession(token),
}));

const { OtpVerification, formatCountdown } =
  await import("./otp-verification.js");

const REQUEST_URL = "/api/platform-admin/mfa/request";
const VERIFY_URL = "/api/platform-admin/mfa/verify";
const SENT = {
  data: {
    sent: true,
    sentTo: "o***@openwind.io",
    resendAfterSeconds: 30,
    expiresInSeconds: 600,
  },
};

function boxes(): HTMLInputElement[] {
  return Array.from({ length: 6 }, (_, i) =>
    screen.getByLabelText<HTMLInputElement>(`Digit ${i + 1}`),
  );
}

function box(index: number): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(`Digit ${index + 1}`);
}

function typeCode(code: string): void {
  code.split("").forEach((d, i) => {
    fireEvent.change(box(i), { target: { value: d } });
  });
}

function verifyCalls(): unknown[][] {
  return mockFetchWithAuth.mock.calls.filter((c) => c[0] === VERIFY_URL);
}

function renderFlow(): { onVerified: ReturnType<typeof vi.fn> } {
  const onVerified = vi.fn();
  render(<OtpVerification onVerified={onVerified} />);
  return { onVerified };
}

describe("OtpVerification", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockImplementation((url) =>
      Promise.resolve(
        url === REQUEST_URL
          ? SENT
          : { data: { verified: true, sessionToken: "tok-1" } },
      ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("sends one code on mount and shows the masked address it went to", async () => {
    renderFlow();

    expect(await screen.findByText("o***@openwind.io")).toBeTruthy();
    expect(
      mockFetchWithAuth.mock.calls.filter((c) => c[0] === REQUEST_URL),
    ).toHaveLength(1);
  });

  it("moves to the next box as digits are typed, and submits on the sixth", async () => {
    const { onVerified } = renderFlow();
    await screen.findByText("o***@openwind.io");

    fireEvent.change(box(0), { target: { value: "1" } });
    expect(document.activeElement).toBe(boxes()[1]);

    typeCode("123456");

    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(verifyCalls()[0]?.[1]).toEqual({
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(mockSetSession).toHaveBeenCalledWith("tok-1");
  });

  it("spreads a pasted code across the boxes and submits it", async () => {
    const { onVerified } = renderFlow();
    await screen.findByText("o***@openwind.io");

    fireEvent.paste(box(0), {
      clipboardData: { getData: () => " 65-43 21 " },
    });

    expect(boxes().map((b) => b.value)).toEqual(["6", "5", "4", "3", "2", "1"]);
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
  });

  it("ignores non-digits", async () => {
    renderFlow();
    await screen.findByText("o***@openwind.io");

    fireEvent.change(box(0), { target: { value: "a" } });

    expect(box(0).value).toBe("");
  });

  it("replaces a digit typed over an existing one", async () => {
    renderFlow();
    await screen.findByText("o***@openwind.io");
    fireEvent.change(box(0), { target: { value: "3" } });

    fireEvent.change(box(0), { target: { value: "37" } });

    expect(box(0).value).toBe("7");
    expect(box(1).value).toBe("");
  });

  it("clears a box deleted without a Backspace keydown (Delete key, cut, mobile keyboards)", async () => {
    renderFlow();
    await screen.findByText("o***@openwind.io");
    fireEvent.change(box(2), { target: { value: "5" } });

    fireEvent.change(box(2), { target: { value: "" } });

    expect(box(2).value).toBe("");
  });

  it("takes a whole code autofilled into a box that already holds a digit", async () => {
    const { onVerified } = renderFlow();
    await screen.findByText("o***@openwind.io");
    fireEvent.change(box(0), { target: { value: "1" } });

    fireEvent.change(box(0), { target: { value: "1123456" } });

    expect(boxes().map((b) => b.value)).toEqual(["1", "2", "3", "4", "5", "6"]);
    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(verifyCalls()[0]?.[1]).toEqual({
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
  });

  it("puts the cursor back in the first box after a wrong code", async () => {
    mockFetchWithAuth.mockImplementation((url) =>
      url === REQUEST_URL
        ? Promise.resolve(SENT)
        : Promise.reject(
            apiError(422, "INVALID_CODE", "That code is incorrect.", {
              attemptsRemaining: 4,
            }),
          ),
    );
    renderFlow();
    await screen.findByText("o***@openwind.io");

    typeCode("000000");

    await screen.findByText("That code is incorrect. 4 attempts left.");
    expect(document.activeElement).toBe(box(0));
  });

  it("verifies only once even if the code is completed twice while a check is in flight", async () => {
    let answer: (v: unknown) => void = () => {};
    mockFetchWithAuth.mockImplementation((url) =>
      url === REQUEST_URL
        ? Promise.resolve(SENT)
        : new Promise((resolve) => {
            answer = resolve;
          }),
    );
    renderFlow();
    await screen.findByText("o***@openwind.io");

    typeCode("123456");
    fireEvent.click(screen.getByRole("button", { name: /Verif/ }));
    answer({ data: { verified: true, sessionToken: "t" } });

    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
  });

  it("re-enables the boxes once a new code is sent after one expired", async () => {
    let first = true;
    mockFetchWithAuth.mockImplementation((url) => {
      if (url === REQUEST_URL)
        return Promise.resolve({
          data: { ...SENT.data, resendAfterSeconds: 0 },
        });
      if (first) {
        first = false;
        return Promise.reject(apiError(422, "CODE_EXPIRED", "Expired."));
      }
      return Promise.resolve({ data: { verified: true, sessionToken: "t" } });
    });
    renderFlow();
    await screen.findByText("o***@openwind.io");
    typeCode("000000");
    await screen.findByText("Expired.");
    expect(box(0).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resend code" }));

    await waitFor(() => expect(box(0).disabled).toBe(false));
    expect(screen.queryByText("Expired.")).toBeNull();
  });

  it("Backspace on an empty box clears the previous one and moves back", async () => {
    renderFlow();
    await screen.findByText("o***@openwind.io");
    fireEvent.change(box(0), { target: { value: "7" } });

    fireEvent.keyDown(box(1), { key: "Backspace" });

    expect(box(0).value).toBe("");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("on a wrong code shows the attempts left, clears the boxes, and does not verify", async () => {
    mockFetchWithAuth.mockImplementation((url) =>
      url === REQUEST_URL
        ? Promise.resolve(SENT)
        : Promise.reject(
            apiError(422, "INVALID_CODE", "That code is incorrect.", {
              attemptsRemaining: 2,
            }),
          ),
    );
    const { onVerified } = renderFlow();
    await screen.findByText("o***@openwind.io");

    typeCode("000000");

    expect(
      await screen.findByText("That code is incorrect. 2 attempts left."),
    ).toBeTruthy();
    expect(boxes().every((b) => b.value === "")).toBe(true);
    expect(box(0).disabled).toBe(false);
    expect(onVerified).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it.each([
    ["TOO_MANY_ATTEMPTS", "Too many incorrect attempts. Request a new code."],
    [
      "CODE_EXPIRED",
      "This code has expired or was already used. Request a new one.",
    ],
  ])(
    "on %s shows the message and locks the boxes until a new code is sent",
    async (code, message) => {
      mockFetchWithAuth.mockImplementation((url) =>
        url === REQUEST_URL
          ? Promise.resolve(SENT)
          : Promise.reject(apiError(422, code, message)),
      );
      renderFlow();
      await screen.findByText("o***@openwind.io");

      typeCode("000000");

      expect(await screen.findByText(message)).toBeTruthy();
      expect(box(0).disabled).toBe(true);
    },
  );

  it("counts the code's lifetime down and locks the boxes once it expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderFlow();
    await screen.findByText("Code expires in 10:00");

    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    // Fake timers also follow real time here, so allow a second or two of drift on slow CI.
    expect(screen.getByText(/^Code expires in 8:5\d$/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(540_000);
    });
    expect(
      screen.getByText("This code has expired. Request a new one."),
    ).toBeTruthy();
    expect(box(0).disabled).toBe(true);
  });

  it("enables Resend only after the server's cooldown, then sends a new code", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderFlow();
    const waiting = await screen.findByRole("button", {
      name: "Resend code in 0:30",
    });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const resend = screen.getByRole("button", { name: "Resend code" });
    fireEvent.click(resend);

    await waitFor(() => {
      expect(
        mockFetchWithAuth.mock.calls.filter((c) => c[0] === REQUEST_URL),
      ).toHaveLength(2);
    });
  });

  it("adopts the wait from a 429 (a code was just sent) instead of showing an error", async () => {
    mockFetchWithAuth.mockImplementation((url) =>
      url === REQUEST_URL
        ? Promise.reject(
            apiError(429, "MFA_RESEND_TOO_SOON", "too soon", {
              retryAfterSeconds: 12,
            }),
          )
        : Promise.resolve({ data: { verified: true, sessionToken: "t" } }),
    );
    renderFlow();

    expect(
      await screen.findByRole("button", { name: "Resend code in 0:12" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(box(0).disabled).toBe(false); // the earlier code is still usable
  });

  it("shows a send failure and keeps the boxes locked until a code is sent", async () => {
    mockFetchWithAuth.mockImplementation((url) =>
      url === REQUEST_URL
        ? Promise.reject(
            apiError(502, "SEND_FAILED", "Could not send verification code"),
          )
        : Promise.resolve({}),
    );
    renderFlow();

    expect(
      await screen.findByText("Could not send verification code"),
    ).toBeTruthy();
    expect(box(0).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Resend code" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("treats a success response without a session token as a failure", async () => {
    mockFetchWithAuth.mockImplementation((url) =>
      Promise.resolve(
        url === REQUEST_URL ? SENT : { data: { verified: true } },
      ),
    );
    const { onVerified } = renderFlow();
    await screen.findByText("o***@openwind.io");

    typeCode("123456");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onVerified).not.toHaveBeenCalled();
  });
});

describe("formatCountdown", () => {
  it.each([
    [600, "10:00"],
    [59.2, "1:00"],
    [5, "0:05"],
    [-3, "0:00"],
  ])("%s -> %s", (seconds, expected) => {
    expect(formatCountdown(seconds)).toBe(expected);
  });
});
