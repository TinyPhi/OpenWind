/**
 * The platform-admin MFA session token (docs/specs/multi-org-sandbox.md R1): the API issues it
 * when a code is verified, and only requests carrying it count as verified. It belongs to one
 * sign-in, so it is dropped on every completed sign-in and on sign-out -- that is what makes a
 * code necessary on every platform-admin login.
 *
 * Kept in localStorage, beside the OIDC user, so every tab of one sign-in shares it. The
 * in-memory copy keeps the current page working when storage is unavailable (private mode,
 * blocked site data); it is then simply lost on reload, which costs one more code.
 */

export const PLATFORM_ADMIN_MFA_SESSION_HEADER = "X-Platform-Admin-Mfa";

const STORAGE_KEY = "openwind.platformAdminMfaSession";
const PLATFORM_ADMIN_API_PATH = "/api/platform-admin/";

let memoryToken: string | null = null;
// False once a write has failed (blocked storage, quota): from then on only memory is trusted, or
// a token that was never stored would read back as "none" and the code screen would loop.
let storageWritable = true;

export function getPlatformAdminMfaSession(): string | null {
  if (!storageWritable) return memoryToken;
  try {
    // Storage wins whenever it can be read: a sign-out in another tab removes the token there,
    // and this tab must stop sending it too.
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryToken;
  }
}

export function setPlatformAdminMfaSession(token: string): void {
  memoryToken = token;
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
    storageWritable = true;
  } catch {
    // Storage unavailable: the in-memory copy still covers this page.
    storageWritable = false;
  }
}

export function clearPlatformAdminMfaSession(): void {
  memoryToken = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
}

/** Adds the token to requests for the platform-admin API only -- never anywhere else. */
export function addPlatformAdminMfaHeader(url: URL, headers: Headers): void {
  if (!url.pathname.startsWith(PLATFORM_ADMIN_API_PATH)) return;
  const token = getPlatformAdminMfaSession();
  if (token) headers.set(PLATFORM_ADMIN_MFA_SESSION_HEADER, token);
}
