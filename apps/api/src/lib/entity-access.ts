/**
 * Shared record-level read-access check for entity instances gated by the
 * __accessUsers field ACL (see create-attachment.ts / add-comment.ts for the
 * sibling write-side checks this mirrors).
 */
export function hasEntityReadAccess(
  instance: {
    createdBy: string | null;
    assignedTo: string | null;
    fields: unknown;
  },
  userId: string,
  roles: string[],
): boolean {
  if (roles.includes("admin") || roles.includes("agent")) return true;
  if (instance.createdBy === userId || instance.assignedTo === userId) {
    return true;
  }

  const accessUsers =
    (instance.fields as Record<string, unknown> | null)?.__accessUsers ?? {};
  const level = (accessUsers as Record<string, { level: string }>)[userId]
    ?.level;
  return (
    level === "read_only" || level === "read_comment" || level === "read_write"
  );
}
