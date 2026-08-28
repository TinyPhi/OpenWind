/**
 * Helper to identify unique constraint violations on a specific constraint.
 */
export function isUniqueViolation(
  err: unknown,
  constraintName?: string,
): boolean {
  const cause = err instanceof Error && "cause" in err ? err.cause : err;
  if (cause instanceof Error && "code" in cause && cause.code === "23505") {
    if (constraintName === undefined) {
      return true;
    }
    return (
      "constraint_name" in cause && cause.constraint_name === constraintName
    );
  }
  return false;
}

/**
 * Helper to identify check constraint violations on a specific constraint (or matching a prefix/suffix).
 */
export function isCheckViolation(
  err: unknown,
  match: string | ((constraintName: string) => boolean),
): boolean {
  const cause = err instanceof Error && "cause" in err ? err.cause : err;
  if (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "23514" &&
    "constraint_name" in cause &&
    typeof cause.constraint_name === "string"
  ) {
    if (typeof match === "function") {
      return match(cause.constraint_name);
    }
    return (
      cause.constraint_name.startsWith(match) ||
      cause.constraint_name.endsWith(match)
    );
  }
  return false;
}
