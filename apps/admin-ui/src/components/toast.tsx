import React, { useCallback, useEffect, useState } from "react";
import { TOKENS } from "@platform/ui";

/**
 * Short, non-blocking messages in the bottom-right corner ("toasts"), mounted once at the app root.
 * Same window-CustomEvent pattern as global-alert-dialog.tsx, so any file can show one without
 * React context plumbing. Use showToast() rather than dispatching the event directly.
 *
 * For a result the user only needs to read (an action finished, with a note). Anything they must
 * acknowledge or decide stays a dialog (showAlert / showConfirm).
 */

export type ToastTone = "success" | "info" | "warning" | "error";

export interface ToastInput {
  title: string;
  message?: string | undefined;
  tone?: ToastTone;
}

interface Toast extends ToastInput {
  id: number;
}

const EVENT = "ui:toast";
/** Long enough to read two sentences. */
export const TOAST_DURATION_MS = 8_000;

let nextId = 0;

export function showToast(toast: ToastInput): void {
  window.dispatchEvent(new CustomEvent<ToastInput>(EVENT, { detail: toast }));
}

const ACCENT: Record<ToastTone, string> = {
  success: "hsl(142, 60%, 42%)",
  info: "hsl(210, 80%, 56%)",
  warning: "hsl(38, 92%, 50%)",
  error: "hsl(350, 80%, 60%)",
};

export function ToastHost(): React.ReactElement | null {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onToast = (event: Event): void => {
      const detail = (event as CustomEvent<ToastInput>).detail;
      const id = ++nextId;
      setToasts((all) => [...all, { ...detail, id }]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        dismiss(id);
      }, TOAST_DURATION_MS);
      timers.add(timer);
    };
    window.addEventListener(EVENT, onToast);
    return (): void => {
      window.removeEventListener(EVENT, onToast);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [dismiss]);

  // The live region stays mounted while empty: screen readers often miss a message that arrives in
  // the same moment as the region itself.
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: 380,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          data-testid="toast"
          data-tone={t.tone ?? "info"}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            padding: "12px 14px",
            borderRadius: 10,
            background: TOKENS.bgSecondary,
            border: `1px solid ${TOKENS.borderColor}`,
            borderLeft: `4px solid ${ACCENT[t.tone ?? "info"]}`,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
          }}
        >
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: TOKENS.textPrimary,
              }}
            >
              {t.title}
            </div>
            {t.message && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  color: TOKENS.textSecondary,
                }}
              >
                {t.message}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            style={{
              border: "none",
              background: "transparent",
              color: TOKENS.textMuted,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
