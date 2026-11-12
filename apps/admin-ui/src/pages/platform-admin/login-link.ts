/**
 * The login link a prospect is handed for a sandbox, /login?org=<loginKey> (docs/specs/multi-org-sandbox.md
 * R13). The login page looks the key up and shows that sandbox's brand. The key is random, 16
 * lowercase hex characters, so encoding it is a no-op today; it stays as a guard against a format
 * that ever loosens.
 */
export function loginLink(
  loginKey: string,
  origin: string = window.location.origin,
): string {
  return `${origin}/login?org=${encodeURIComponent(loginKey)}`;
}
