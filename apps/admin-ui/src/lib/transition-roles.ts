/** Mirrors the engine's role check: an empty `allowedRoles` means any role may use it. */
export function filterTransitionsByRoles<T extends { allowedRoles?: string[] }>(
  transitions: T[],
  roles: string[],
): T[] {
  return transitions.filter(
    (t) =>
      !t.allowedRoles?.length || t.allowedRoles.some((r) => roles.includes(r)),
  );
}
