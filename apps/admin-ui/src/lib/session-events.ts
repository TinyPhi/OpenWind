// Dependency-free hook so module-level caches can reset when the session ends
// without importing authProvider (which would create an api <-> authProvider cycle).
const listeners = new Set<() => void>();

/** Register a callback run when the user logs out. Returns an unsubscribe fn. */
export function onSessionEnd(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitSessionEnd(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a failing cache reset must never block logout
    }
  }
}
