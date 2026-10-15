import React from "react";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { setPlatformAdminMfaSession } from "../../lib/platform-admin-mfa-session.js";
import "./platform-admin.css";

const CODE_LENGTH = 6;

type ApiError = Error & {
  status?: number;
  code?: string;
  meta?: { retryAfterSeconds?: unknown; attemptsRemaining?: unknown };
};

function positiveSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : 0;
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Digit boxes ─────────────────────────────────────────────────────────────

export interface OtpCodeInputProps {
  digits: string[];
  onChange: (digits: string[]) => void;
  /** Called once all boxes are filled, with the full code. */
  onComplete: (code: string) => void;
  /** No input at all (the code can't be used). The boxes stay focusable while merely busy. */
  disabled?: boolean;
  /** Busy (sending or verifying): input is ignored but focus is kept, so typing can resume. */
  readOnly?: boolean;
  invalid?: boolean;
  /** Changing this puts the cursor back in the first box (after a reset or a new code). */
  focusKey?: number;
}

/**
 * The digit a change actually inserted into box `current`. Typing over a digit gives two
 * characters (old + new, either order): prefer the event's own data, else drop one copy of the
 * old digit.
 */
function insertedDigit(
  value: string,
  current: string,
  data: string | null,
): string {
  if (data && /^\d$/.test(data)) return data;
  const digitsOnly = value.replace(/\D/g, "");
  if (!current) return digitsOnly;
  const at = digitsOnly.indexOf(current);
  return at === -1
    ? digitsOnly
    : digitsOnly.slice(0, at) + digitsOnly.slice(at + 1);
}

/**
 * Six single-digit boxes: typing moves to the next box, Backspace on an empty box goes back,
 * and pasting (or the browser's one-time-code autofill) anywhere spreads the digits across.
 */
export function OtpCodeInput({
  digits,
  onChange,
  onComplete,
  disabled = false,
  readOnly = false,
  invalid = false,
  focusKey = 0,
}: OtpCodeInputProps): React.ReactElement {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);

  React.useEffect(() => {
    if (!disabled) refs.current[0]?.focus();
  }, [focusKey, disabled]);

  function focusBox(index: number): void {
    refs.current[Math.max(0, Math.min(CODE_LENGTH - 1, index))]?.focus();
  }

  function clearBox(index: number): void {
    const next = [...digits];
    next[index] = "";
    onChange(next);
  }

  function fill(from: number, typed: string): void {
    if (readOnly) return;
    const incoming = typed.replace(/\D/g, "").slice(0, CODE_LENGTH - from);
    if (!incoming) return;
    const next = [...digits];
    for (let i = 0; i < incoming.length; i++)
      next[from + i] = incoming[i] ?? "";
    onChange(next);
    focusBox(from + incoming.length);
    if (next.every((d) => d !== "")) onComplete(next.join(""));
  }

  function handleKeyDown(
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (readOnly) return;
      const next = [...digits];
      if (next[index]) {
        next[index] = "";
      } else if (index > 0) {
        next[index - 1] = "";
        focusBox(index - 1);
      }
      onChange(next);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBox(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBox(index + 1);
    }
  }

  return (
    <div
      className="pa-otp"
      role="group"
      aria-label="Verification code"
      data-invalid={invalid || undefined}
    >
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="pa-otp-box"
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid || undefined}
          value={digit}
          disabled={disabled}
          readOnly={readOnly}
          // Room for a whole code beside the current digit, so autofill or a keyboard's
          // suggested code is never cut short before it can be spread across the boxes.
          maxLength={CODE_LENGTH + 1}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const value = e.target.value;
            if (readOnly) return;
            // Delete key, cut, or a mobile keyboard's backspace (no Backspace keydown).
            if (!value) {
              clearBox(i);
              return;
            }
            const digitsOnly = value.replace(/\D/g, "");
            if (digitsOnly.length >= CODE_LENGTH) {
              // A whole code arrived at once (autofill, keyboard suggestion): it replaces the
              // entire entry, whatever box received it.
              fill(0, digitsOnly.slice(-CODE_LENGTH));
              return;
            }
            const data = (e.nativeEvent as InputEvent).data ?? null;
            fill(i, insertedDigit(value, digit, data));
          }}
          onPaste={(e) => {
            e.preventDefault();
            fill(i, e.clipboardData.getData("text"));
          }}
          onKeyDown={(e) => handleKeyDown(i, e)}
        />
      ))}
    </div>
  );
}

// ── Request / verify flow ───────────────────────────────────────────────────

export interface OtpVerificationProps {
  /** Called after a code is verified and the new MFA session token is stored. */
  onVerified: () => void;
  /** Rendered on the left of the action row (e.g. Cancel in the step-up dialog). */
  secondaryAction?: React.ReactNode;
}

/**
 * Sends a code when it mounts, then verifies it. Shows where the code went, how long it stays
 * valid and when it can be resent, using the server's own values (the cooldown and lifetime
 * are config, not constants here). A verified code's session token is stored so every later
 * platform-admin request carries it.
 */
export function OtpVerification({
  onVerified,
  secondaryAction,
}: OtpVerificationProps): React.ReactElement {
  const [digits, setDigits] = React.useState<string[]>(() =>
    Array<string>(CODE_LENGTH).fill(""),
  );
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The code can no longer be used (expired, locked, or never sent): only a resend helps.
  const [needsNewCode, setNeedsNewCode] = React.useState(false);
  const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
  const [resendAt, setResendAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
  const requested = React.useRef(false);
  const verifyingRef = React.useRef(false);
  const [focusKey, setFocusKey] = React.useState(0);

  const clearDigits = React.useCallback(() => {
    setDigits(Array<string>(CODE_LENGTH).fill(""));
    setFocusKey((k) => k + 1);
  }, []);

  const sendCode = React.useCallback(async (): Promise<void> => {
    setSending(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_URL}/platform-admin/mfa/request`, {
        method: "POST",
      });
      // fetchWithAuth returns unknown; each field read here is type-checked before use.
      const data = (res as { data?: Record<string, unknown> }).data ?? {};
      const at = Date.now();
      setNow(at);
      setSentTo(typeof data.sentTo === "string" ? data.sentTo : null);
      const expiresIn = positiveSeconds(data.expiresInSeconds);
      setExpiresAt(expiresIn ? at + expiresIn * 1000 : null);
      setResendAt(at + positiveSeconds(data.resendAfterSeconds) * 1000);
      setNeedsNewCode(false);
      clearDigits();
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 429) {
        // A code from moments ago is still valid; just show when another can be sent.
        const at = Date.now();
        setNow(at);
        setResendAt(at + positiveSeconds(e.meta?.retryAfterSeconds) * 1000);
        if (needsNewCode) {
          setError(
            "A code was sent moments ago. Resend once the countdown ends.",
          );
        }
      } else {
        setError(e.message || "Could not send the code. Try again.");
        setNeedsNewCode(true);
      }
    } finally {
      setSending(false);
    }
  }, [clearDigits, needsNewCode]);

  React.useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void sendCode();
  }, [sendCode]);

  const ticking =
    (expiresAt !== null && expiresAt > now) ||
    (resendAt !== null && resendAt > now);
  React.useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const expiresIn = expiresAt === null ? null : (expiresAt - now) / 1000;
  const expired = expiresIn !== null && expiresIn <= 0;
  const resendIn = resendAt === null ? 0 : Math.ceil((resendAt - now) / 1000);
  const code = digits.join("");
  const inputLocked = needsNewCode || expired;
  const busy = verifying || sending;

  async function verify(submitted: string): Promise<void> {
    if (verifyingRef.current || submitted.length !== CODE_LENGTH) return;
    verifyingRef.current = true;
    setVerifying(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`${API_URL}/platform-admin/mfa/verify`, {
        method: "POST",
        body: JSON.stringify({ code: submitted }),
      });
      const token = (res as { data?: { sessionToken?: unknown } }).data
        ?.sessionToken;
      if (typeof token !== "string" || !token) {
        throw new Error("Verification failed. Try again.");
      }
      setPlatformAdminMfaSession(token);
      onVerified();
    } catch (err) {
      const e = err as ApiError;
      if (e.code === "INVALID_CODE") {
        const left = positiveSeconds(e.meta?.attemptsRemaining);
        setError(
          left
            ? `That code is incorrect. ${left} ${left === 1 ? "attempt" : "attempts"} left.`
            : "That code is incorrect.",
        );
      } else if (e.code === "CODE_EXPIRED" || e.code === "TOO_MANY_ATTEMPTS") {
        setError(e.message);
        setNeedsNewCode(true);
      } else {
        setError(e.message || "Verification failed. Try again.");
      }
      clearDigits();
      verifyingRef.current = false;
      setVerifying(false);
    }
  }

  return (
    <form
      className="pa-otp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void verify(code);
      }}
    >
      <p className="pa-otp-sent" aria-live="polite">
        {sending ? (
          "Sending a code…"
        ) : sentTo ? (
          <>
            We sent a 6-digit code to <strong>{sentTo}</strong>.
          </>
        ) : (
          "Enter the 6-digit code sent to your email."
        )}
      </p>

      <OtpCodeInput
        digits={digits}
        onChange={(next) => {
          setDigits(next);
          if (error && !needsNewCode) setError(null);
        }}
        onComplete={(full) => void verify(full)}
        disabled={inputLocked}
        readOnly={busy}
        invalid={error !== null}
        focusKey={focusKey}
      />

      <p className="pa-otp-status" aria-live="polite">
        {expired
          ? "This code has expired. Request a new one."
          : expiresIn !== null && !needsNewCode
            ? `Code expires in ${formatCountdown(expiresIn)}`
            : " "}
      </p>

      {error && (
        <p role="alert" className="pa-otp-error">
          {error}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        disabled={inputLocked || busy || code.length !== CODE_LENGTH}
        style={{ width: "100%" }}
      >
        {verifying ? "Verifying…" : "Verify"}
      </Button>

      <div className="pa-otp-actions">
        {secondaryAction ?? <span />}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void sendCode()}
          disabled={sending || verifying || resendIn > 0}
        >
          {resendIn > 0
            ? `Resend code in ${formatCountdown(resendIn)}`
            : "Resend code"}
        </Button>
      </div>
    </form>
  );
}
