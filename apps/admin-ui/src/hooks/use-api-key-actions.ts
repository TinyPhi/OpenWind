import { useState, useCallback } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";

export type ApiKeyActionKind = "revoke" | "rotate" | "emergency-rotate";

export type ApiKeyActionResult = {
  id: string;
  key: string;
  expiresAt: string | null;
};

// ADR-012 Phase A spec R5: Emergency Rotate is a distinct action from Rotate
// with its own, more severe warning — never share copy with Rotate's, so a
// future change to one can't silently soften the other's warning.
export const API_KEY_ACTION_CONFIRM_COPY: Record<
  ApiKeyActionKind,
  { title: string; message: string; confirmLabel: string; busyLabel: string }
> = {
  revoke: {
    title: "Revoke this key?",
    message:
      "The key stops authenticating immediately — no grace period. Any integration using it breaks right away.",
    confirmLabel: "Revoke",
    busyLabel: "Revoking…",
  },
  rotate: {
    title: "Rotate this key?",
    message:
      "A new key is issued now. This key keeps authenticating for 24 more hours so the integration can switch over, then stops working automatically.",
    confirmLabel: "Rotate",
    busyLabel: "Rotating…",
  },
  "emergency-rotate": {
    title: "Emergency Rotate this key?",
    message:
      "This integration breaks immediately — there is no 24-hour grace period. A new key is issued now; the old key (and any key still mid-rotation from it) stops authenticating right away.",
    confirmLabel: "Emergency Rotate",
    busyLabel: "Rotating…",
  },
};

/**
 * Revoke/Rotate/Emergency-Rotate don't fit Refine's CRUD verbs cleanly, so
 * this hook calls the routes directly via fetchWithAuth (same pattern as
 * use-file-upload.ts's non-CRUD upload calls) instead of going through
 * dataProvider.
 */
export function useApiKeyActions(): {
  busyKeyId: string | null;
  error: string | null;
  revoke: (id: string) => Promise<boolean>;
  rotate: (id: string) => Promise<ApiKeyActionResult | null>;
  emergencyRotate: (id: string) => Promise<ApiKeyActionResult | null>;
} {
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = useCallback(async (id: string): Promise<boolean> => {
    setBusyKeyId(id);
    setError(null);
    try {
      await fetchWithAuth(`${API_URL}/api-keys/${id}`, { method: "DELETE" });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
      return false;
    } finally {
      setBusyKeyId(null);
    }
  }, []);

  const rotate = useCallback(
    async (id: string): Promise<ApiKeyActionResult | null> => {
      setBusyKeyId(id);
      setError(null);
      try {
        const res = (await fetchWithAuth(`${API_URL}/api-keys/${id}/rotate`, {
          method: "POST",
        })) as { data: ApiKeyActionResult };
        return res.data;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rotate key");
        return null;
      } finally {
        setBusyKeyId(null);
      }
    },
    [],
  );

  const emergencyRotate = useCallback(
    async (id: string): Promise<ApiKeyActionResult | null> => {
      setBusyKeyId(id);
      setError(null);
      try {
        const res = (await fetchWithAuth(
          `${API_URL}/api-keys/${id}/emergency-rotate`,
          { method: "POST" },
        )) as { data: ApiKeyActionResult };
        return res.data;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to emergency-rotate key",
        );
        return null;
      } finally {
        setBusyKeyId(null);
      }
    },
    [],
  );

  return { busyKeyId, error, revoke, rotate, emergencyRotate };
}
