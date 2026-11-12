import { userManager } from "../authProvider.js";
import { API_URL } from "./api.js";

// Mirrors the caps the API enforces on POST /client-errors.
const MAX_MESSAGE = 1_000;
const MAX_STACK = 8_000;
const MAX_COMPONENT_STACK = 4_000;
// One broken screen can re-render and re-throw; the server rate-limits too, but there is no
// reason to send the same failure twice or flood a page that is already failing.
const MAX_REPORTS_PER_PAGE_LOAD = 5;

const sent = new Set<string>();

/**
 * Sends a caught browser error to the API so it reaches the server's error tracking (#810).
 * Fire-and-forget: it never throws, never shows a banner on failure (plain fetch, not
 * fetchWithAuth, which raises the global error banner) and skips an error it already sent.
 */
export async function reportClientError(
  error: Error,
  componentStack?: string | null,
): Promise<void> {
  try {
    const key = `${error.name}:${error.message}`;
    if (sent.has(key) || sent.size >= MAX_REPORTS_PER_PAGE_LOAD) return;
    sent.add(key);

    const token = (await userManager.getUser())?.access_token;
    if (!token) return;

    await fetch(`${API_URL}/client-errors`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        kind: "route_boundary",
        message: (error.message || error.name).slice(0, MAX_MESSAGE),
        ...(error.stack ? { stack: error.stack.slice(0, MAX_STACK) } : {}),
        ...(componentStack
          ? { componentStack: componentStack.slice(0, MAX_COMPONENT_STACK) }
          : {}),
        path: window.location.pathname.slice(0, 300),
      }),
    });
  } catch {
    // Reporting must never make a failing screen worse.
  }
}

/** Test seam: forgets what was sent. */
export function resetClientErrorReportingForTests(): void {
  sent.clear();
}
