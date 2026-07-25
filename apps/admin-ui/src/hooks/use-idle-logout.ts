import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { authProvider } from "../authProvider.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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
 */
export function useIdleLogout(timeoutMs: number = DEFAULT_TIMEOUT_MS): void {
  const navigate = useNavigate();

  useEffect(() => {
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
      timer = setTimeout(handleTimeout, timeoutMs);
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
  }, [timeoutMs, navigate]);
}
