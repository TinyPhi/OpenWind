import React, { useState } from "react";
import { Dialog, DialogContent, DialogTitle, Button } from "@platform/ui";

export interface KeyRevealModalProps {
  open: boolean;
  title: string;
  rawKey: string | null;
  onClose: () => void;
}

/**
 * Shared "here's your key, copy it now" screen — used by both the create
 * flow and Rotate/Emergency Rotate's result, which previously showed the raw
 * key via a plain text showAlert() with no way to copy it except manual
 * select. A raw key is only ever shown once (it can't be recovered later),
 * so a one-click copy matters more here than almost anywhere else in the UI.
 */
export function KeyRevealModal({
  open,
  title,
  rawKey,
  onClose,
}: KeyRevealModalProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  function handleCopy(): void {
    if (!rawKey) return;
    void navigator.clipboard.writeText(rawKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent showCloseButton={false} style={{ maxWidth: 480 }}>
        <DialogTitle asChild>
          <h2 className="page-title">{title}</h2>
        </DialogTitle>
        <p className="page-subtitle">
          Copy this key now — it cannot be shown again.
        </p>
        <div style={{ position: "relative", marginTop: 12 }}>
          <pre
            style={{
              padding: "12px 44px 12px 12px",
              background: "var(--surface-2, #f3f4f6)",
              borderRadius: "8px",
              wordBreak: "break-all",
              whiteSpace: "pre-wrap",
              userSelect: "all",
              margin: 0,
            }}
          >
            {rawKey}
          </pre>
          <button
            type="button"
            aria-label="Copy key"
            onClick={handleCopy}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              padding: 0,
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              cursor: "pointer",
              color: copied
                ? "var(--success, hsl(150, 60%, 45%))"
                : "var(--text-muted)",
            }}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M20 6L9 17l-5-5"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect
                  x="9"
                  y="9"
                  width="12"
                  height="12"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="2"
                />
                <path
                  d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
        <Button
          variant="primary"
          style={{ marginTop: "20px" }}
          onClick={() => {
            setCopied(false);
            onClose();
          }}
        >
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
