import React, { useEffect, useState, useCallback } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@platform/ui";

/**
 * Replaces native alert()/confirm() (#201) with the shared AlertDialog
 * primitive (#199), mounted once at the app root — mirrors
 * global-error-banner.tsx's window-CustomEvent pattern so any file, including
 * hooks that have no JSX render scope of their own (e.g. use-file-upload.ts),
 * can trigger a dialog without needing React context plumbing.
 *
 * Use showAlert()/showConfirm() below rather than dispatching the event
 * directly.
 */

type AlertDialogEventDetail = {
  kind: "alert" | "confirm";
  title: string;
  message: string;
  resolve: (confirmed: boolean) => void;
};

interface AlertRequest extends AlertDialogEventDetail {
  id: number;
}

let _nextId = 0;

export function showAlert(message: string, title = "Notice"): void {
  window.dispatchEvent(
    new CustomEvent<AlertDialogEventDetail>("ui:alert-dialog", {
      detail: { kind: "alert", title, message, resolve: () => undefined },
    }),
  );
}

export function showConfirm(
  message: string,
  title = "Confirm",
): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<AlertDialogEventDetail>("ui:alert-dialog", {
        detail: { kind: "confirm", title, message, resolve },
      }),
    );
  });
}

export function GlobalAlertDialog(): React.ReactElement | null {
  const [queue, setQueue] = useState<AlertRequest[]>([]);

  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<AlertDialogEventDetail>).detail;
      const id = ++_nextId;
      setQueue((prev) => [...prev, { id, ...detail }]);
    };
    window.addEventListener("ui:alert-dialog", handler);
    return () => window.removeEventListener("ui:alert-dialog", handler);
  }, []);

  const dismiss = useCallback((id: number, confirmed: boolean) => {
    setQueue((prev) => {
      const req = prev.find((r) => r.id === id);
      req?.resolve(confirmed);
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const current = queue[0];
  if (!current) return null;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss(current.id, false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{current.title}</AlertDialogTitle>
        <AlertDialogDescription>{current.message}</AlertDialogDescription>
        <AlertDialogFooter>
          {/* No onClick here: Cancel already triggers onOpenChange(false)
              via Radix, which calls dismiss(...) above - an explicit
              handler here would double-fire it (dismiss is idempotent-safe
              since resolve() and the queue filter are both no-ops on a
              second call, but there's no reason to rely on that). */}
          {current.kind === "confirm" && (
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          )}
          <AlertDialogAction onClick={() => dismiss(current.id, true)}>
            {current.kind === "confirm" ? "Confirm" : "OK"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
