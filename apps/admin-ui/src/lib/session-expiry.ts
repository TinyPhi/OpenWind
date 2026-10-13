import { userManager } from "../authProvider.js";
import { emitSessionEnd } from "./session-events.js";

const NOTICE_KEY = "ow:auth-notice";
const SESSION_EXPIRED = "session_expired";

const LOGIN_PATHS = new Set(["/login", "/platform-admin/login"]);

let redirecting = false;

/**
 * Whether a 401 that already survived the silent-refresh retry means the session itself
 * is gone. Only the auth layer's own "UNAUTHORIZED" (or a bare 401 with no code, e.g. from
 * a proxy) counts -- a route-level 401 like the platform-admin MFA "INVALID_CODE" is an
 * ordinary failure and must not log anyone out.
 */
export function isSessionEndingUnauthorized(
  status: number,
  errorCode: string | undefined,
): boolean {
  return (
    status === 401 && (errorCode === undefined || errorCode === "UNAUTHORIZED")
  );
}

/**
 * Ends the local session and hard-navigates to the matching login page, leaving a one-shot
 * notice for GlobalErrorBanner to show there. A full page load (not a router navigate) is
 * deliberate: it drops every in-flight request and cached tenant state at once. Runs once,
 * however many requests fail together.
 */
export function endSessionAndRedirectToLogin(): void {
  if (redirecting) return;
  const path = window.location.pathname;
  if (LOGIN_PATHS.has(path) || path.startsWith("/auth/callback")) return;
  redirecting = true;

  emitSessionEnd();
  try {
    window.sessionStorage.setItem(NOTICE_KEY, SESSION_EXPIRED);
  } catch {
    // Storage blocked (private mode etc.): the redirect still happens, just without the notice.
  }
  const target = path.startsWith("/platform-admin")
    ? "/platform-admin/login"
    : "/login";
  void userManager
    .removeUser()
    .catch(() => undefined)
    .finally(() => {
      window.location.replace(target);
    });
}

/** Reads and clears the one-shot notice, so it shows exactly once. */
export function consumeSessionExpiredNotice(): boolean {
  try {
    const value = window.sessionStorage.getItem(NOTICE_KEY);
    if (value === null) return false;
    window.sessionStorage.removeItem(NOTICE_KEY);
    return value === SESSION_EXPIRED;
  } catch {
    return false;
  }
}

export function resetSessionExpiryForTests(): void {
  redirecting = false;
}
