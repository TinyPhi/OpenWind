import { authProvider } from "../../authProvider.js";
import { fetchWithAuth, API_URL } from "../../lib/api.js";

/**
 * Ends this sign-in's MFA session on the server, then signs out (which also drops the local
 * token). The server call is best effort: the session's markers expire on their own, so a
 * failure here must never keep the admin signed in.
 */
export async function signOutPlatformAdmin(): Promise<string | undefined> {
  try {
    await fetchWithAuth(`${API_URL}/platform-admin/mfa/end`, {
      method: "POST",
    });
  } catch {
    // Best effort -- see above.
  }
  const result = await authProvider.logout({});
  return result.redirectTo;
}
