import { userManager } from "../authProvider.js";
import { emitSessionEnd } from "./session-events.js";
import { clearPlatformAdminMfaSession } from "./platform-admin-mfa-session.js";

const NOTICE_KEY = "ow:auth-notice";

/** Why a session was ended -- the login page tells the user which. */
export type SessionEndReason = "session_expired" | "trial_ended" | "suspended";

const REASONS: readonly SessionEndReason[] = [
  "session_expired",
  "trial_ended",
  "suspended",
];

/**
 * Why this login may not use this environment (docs/specs/tenant-access-gate.md). Sign-in goes
 * through Zitadel, which knows nothing about OpenWind tenants, trials or roles, so these come
 * from the API: requireAuth() for the tenant, GET /auth/access for the role.
 */
export type AccessDeniedReason =
  | "TENANT_NOT_FOUND"
  | "TENANT_SUSPENDED"
  | "TENANT_TRIAL_EXPIRED"
  | "NO_ROLE";

const ACCESS_DENIED_STATUS: Readonly<Record<AccessDeniedReason, number>> = {
  TENANT_NOT_FOUND: 404,
  TENANT_SUSPENDED: 403,
  TENANT_TRIAL_EXPIRED: 403,
  NO_ROLE: 403,
};

export const ACCESS_DENIED_PATH = "/access-denied";

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
 * The access-denied reason for a response that says this login may not use the app at all, or
 * null for any other error -- a forbidden action or a missing record must not sign anyone out.
 */
export function accessDeniedReason(
  status: number,
  errorCode: string | undefined,
): AccessDeniedReason | null {
  if (!isAccessDeniedReason(errorCode)) return null;
  return ACCESS_DENIED_STATUS[errorCode] === status ? errorCode : null;
}

export function isAccessDeniedReason(
  value: string | null | undefined,
): value is AccessDeniedReason {
  return (
    value !== null &&
    value !== undefined &&
    Object.hasOwn(ACCESS_DENIED_STATUS, value)
  );
}

/**
 * Sends the person to the access-denied screen, which explains why, counts down and then signs
 * them out at Zitadel too. The stored user is kept for that sign-out's id_token_hint. Platform-
 * admin pages are left alone: a platform admin acting on a missing sandbox can get
 * TENANT_NOT_FOUND without their own access being in question. Runs once.
 */
export function redirectToAccessDenied(reason: AccessDeniedReason): void {
  if (redirecting) return;
  const path = window.location.pathname;
  if (
    path === ACCESS_DENIED_PATH ||
    path.startsWith("/platform-admin") ||
    LOGIN_PATHS.has(path)
  ) {
    return;
  }
  redirecting = true;
  emitSessionEnd();
  window.location.replace(`${ACCESS_DENIED_PATH}?reason=${reason}`);
}

/**
 * Ends the local session and hard-navigates to the matching login page, leaving a one-shot
 * notice (why) for GlobalErrorBanner to show there. A full page load (not a router navigate)
 * is deliberate: it drops every in-flight request and cached tenant state at once. Runs once,
 * however many requests fail together.
 */
export function endSessionAndRedirectToLogin(
  reason: SessionEndReason = "session_expired",
): void {
  if (redirecting) return;
  const path = window.location.pathname;
  if (LOGIN_PATHS.has(path) || path.startsWith("/auth/callback")) return;
  redirecting = true;

  emitSessionEnd();
  // The sign-in is over, so its platform-admin verification goes with it. The server can't be
  // told (it no longer accepts this session), so its marker lapses on its own; dropping the
  // token here leaves no copy in this browser that could be replayed until then.
  clearPlatformAdminMfaSession();
  try {
    window.sessionStorage.setItem(NOTICE_KEY, reason);
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
export function consumeSessionEndNotice(): SessionEndReason | null {
  try {
    const value = window.sessionStorage.getItem(NOTICE_KEY);
    if (value === null) return null;
    window.sessionStorage.removeItem(NOTICE_KEY);
    return REASONS.find((r) => r === value) ?? null;
  } catch {
    return null;
  }
}

export function resetSessionExpiryForTests(): void {
  redirecting = false;
}
