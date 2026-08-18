/**
 * Reports a <PluginSlot> error-boundary catch back to the platform (R7),
 * which records it as a plugin_errors row (R8) — the same table Phase 1/2's
 * server-side failures already write to.
 *
 * Deliberately fire-and-forget: a failure to *report* a failure must never
 * itself throw and break the error boundary's own render path.
 */

import { fetchWithAuth, API_URL } from "./api.js";

export function logPluginSlotError(
  pluginSlug: string,
  slotName: string,
  error: Error,
): void {
  void fetchWithAuth(`${API_URL}/plugins/${pluginSlug}/errors`, {
    method: "POST",
    body: JSON.stringify({
      slotName,
      message: error.message,
      componentStack:
        "componentStack" in error
          ? String((error as { componentStack?: unknown }).componentStack)
          : undefined,
    }),
  }).catch(() => {
    // Best-effort — a failed error report is not itself worth surfacing.
  });
}
