/**
 * Shared across every third-party route — a genuinely nonexistent record and
 * an inaccessible one must be indistinguishable to the caller (404-not-403,
 * security.md), and every code path that denies access (including internal
 * races like a workflow deleted between an instance fetch and a downstream
 * lookup) must return this exact body, never a differently-shaped one.
 */
export function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}
