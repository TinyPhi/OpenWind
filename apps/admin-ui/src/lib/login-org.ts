// The sandbox login link a person signed in through, /login?org=<login key> (multi-org-sandbox R13),
// remembered in this browser so signing out, an idle logout or an expired session lands them back
// on their own organisation's login page and not on the generic /login.

const STORAGE_KEY = "ow-login-org";
// Exactly what the server accepts for a login key: 16 lowercase hex characters.
const KEY_RE = /^[0-9a-f]{16}$/;

export function isLoginOrgKey(value: string | null): value is string {
  return value !== null && KEY_RE.test(value);
}

// Storage can be missing or throw (private windows, blocked site data); the generic /login is the
// fallback, so a failure here is never an error for the visitor.
export function rememberLoginOrg(key: string): void {
  if (!isLoginOrgKey(key)) return;
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // generic /login stays the fallback
  }
}

export function rememberedLoginOrg(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLoginOrgKey(value) ? value : null;
  } catch {
    return null;
  }
}
