// Shared by create.ts and rotate.ts: a caller may only mint (or re-mint, via
// rotation) a key whose every scope sits at or below their own highest role
// in the privilege hierarchy. Checked on rotation too, not just creation —
// otherwise rotating a key would let a since-downgraded admin keep reissuing
// scopes they no longer hold themselves. Unknown scope strings are rejected
// (no known privilege level). (#223)
const ROLE_LEVEL: Record<string, number> = {
  user: 0,
  agent: 1,
  admin: 2,
  superadmin: 3,
};

export function scopeCeilingError(
  roles: string[],
  scopes: string[],
): string | null {
  const creatorMax = Math.max(-1, ...roles.map((r) => ROLE_LEVEL[r] ?? -1));
  for (const scope of scopes) {
    const scopeLevel = ROLE_LEVEL[scope] ?? -1;
    if (scopeLevel < 0 || scopeLevel > creatorMax) {
      return "Cannot grant scope exceeding your own roles";
    }
  }
  return null;
}
