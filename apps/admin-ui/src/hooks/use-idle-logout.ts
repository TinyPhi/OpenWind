import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { authProvider } from "../authProvider.js";

declare const window: Window & {
  __CONFIG__?: {
    IDLE_LOGOUT_ENABLED?: string;
    IDLE_LOGOUT_TIMEOUT_MINUTES?: string;
  };
};

// Runtime config (Docker, via vite.config.ts's envJsPlugin reading the
// repo-root .env.local) wins; Vite build-time env vars are the fallback —
// same precedence authProvider.ts uses for the Zitadel vars, and for the
// same reason: Vite's own client-env injection only sees .env files under
// its own root (apps/admin-ui), not the repo-root .env.local this monorepo
// actually keeps config in.
const viteEnv = import.meta.env as Record<string, string | undefined>;

const DEFAULT_ENABLED = true;
const DEFAULT_TIMEOUT_MINUTES = 5;

// cfg.* is "" (not undefined) when envJsPlugin's source var is unset, so it
// must be normalized to undefined before falling through to the Vite
// fallback via ?? — ?? alone only treats null/undefined as absent, not "".
function emptyToUndefined(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function rawEnabledSetting(): string | undefined {
  const cfg = window.__CONFIG__ ?? {};
  return (
    emptyToUndefined(cfg.IDLE_LOGOUT_ENABLED) ??
    viteEnv["VITE_IDLE_LOGOUT_ENABLED"]
  );
}

function rawTimeoutMinutesSetting(): string | undefined {
  const cfg = window.__CONFIG__ ?? {};
  return (
    emptyToUndefined(cfg.IDLE_LOGOUT_TIMEOUT_MINUTES) ??
    viteEnv["VITE_IDLE_LOGOUT_TIMEOUT_MINUTES"]
  );
}

// Config-driven (docs/specs/auto-logout-on-inactivity.md): the fixed 5-minute
// timeout was too strict for local dev with no way to relax it short of
// editing source.
function isEnabledFromEnv(): boolean {
  const raw = rawEnabledSetting();
  if (raw === undefined) return DEFAULT_ENABLED;
  return raw !== "false";
}

function timeoutMinutesFromEnv(): number {
  const raw = rawTimeoutMinutesSetting();
  const parsed = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TIMEOUT_MINUTES;
}

const ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "mousedown",
  "touchstart",
  "scroll",
] as const;

/**
 * Logs the user out after a period of no activity (docs/specs/
 * auto-logout-on-inactivity.md). Mount only inside authenticated routes —
 * this reuses authProvider.logout(), the same flow a manual logout takes.
 *
 * timeoutMs is an explicit override (used by tests); when omitted, the
 * timeout and the enabled/disabled toggle are both read from env at call
 * time — VITE_IDLE_LOGOUT_ENABLED ("false" to disable, anything else/unset
 * defaults to enabled) and VITE_IDLE_LOGOUT_TIMEOUT_MINUTES (whole minutes,
 * defaults to 5 if unset/invalid).
 */
export function useIdleLogout(timeoutMs?: number): void {
  const navigate = useNavigate();
  const enabled = isEnabledFromEnv();
  const resolvedTimeoutMs = timeoutMs ?? timeoutMinutesFromEnv() * 60 * 1000;

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout>;

    const handleTimeout = (): void => {
      // Always redirect, even if logout() rejects (e.g. storage unavailable)
      // — the point of this feature is to get an idle session off screen,
      // and a rejected promise must not silently cancel that.
      void authProvider.logout({}).finally(() => {
        navigate("/login");
      });
    };

    const resetTimer = (): void => {
      clearTimeout(timer);
      timer = setTimeout(handleTimeout, resolvedTimeoutMs);
    };

    resetTimer();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer);
    }

    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [enabled, resolvedTimeoutMs, navigate]);
}
