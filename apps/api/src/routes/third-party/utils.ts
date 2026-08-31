import type { Context } from "hono";

/**
 * Forwards all headers from a third-party proxy response onto the current
 * Hono context so callers don't have to duplicate the iteration loop.
 */
export function forwardResponseHeaders(
  c: Context,
  response: { headers?: Record<string, string> },
): void {
  if (response.headers) {
    for (const [key, value] of Object.entries(response.headers)) {
      c.header(key, value);
    }
  }
}
