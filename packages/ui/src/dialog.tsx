import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { TOKENS } from "./tokens.js";

/**
 * Consumers must define this repo's standard design tokens on an ancestor
 * element (--radius-lg, --text-primary, --text-muted, --border-color,
 * --shadow-lg, --transition-fast) — see apps/admin-ui/src/index.css. This
 * package ships no CSS of its own (tsc-only build, no asset pipeline), so
 * visual consistency comes from referencing those custom properties inline
 * rather than shipping a separate stylesheet.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.55)",
  backdropFilter: "blur(14px) saturate(160%)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 24,
};

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ style, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      style={{ ...overlayStyle, ...style }}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const contentStyle: React.CSSProperties = {
  position: "relative",
  background: TOKENS.bgSecondary,
  border: `1px solid ${TOKENS.borderColor}`,
  borderRadius: TOKENS.radiusLg,
  width: "100%",
  maxWidth: 540,
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: TOKENS.shadowLg,
  padding: "20px 24px",
};

const closeButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  right: 12,
  cursor: "pointer",
  background: "transparent",
  border: "none",
  color: TOKENS.textMuted,
  fontSize: 18,
  lineHeight: 1,
  padding: 4,
};

/**
 * Cancels every property DialogContent's own inline style sets, so a
 * caller's existing CSS class (e.g. .modal) wins over Dialog's defaults
 * instead of being overridden by them.
 */
export const DIALOG_CONTENT_RESET: React.CSSProperties = {
  background: undefined,
  border: undefined,
  borderRadius: undefined,
  boxShadow: undefined,
  maxWidth: undefined,
  maxHeight: undefined,
  overflowY: undefined,
  padding: 0,
};

export interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /**
   * Set false when the modal's own body already supplies a close control
   * (e.g. a header "×" button) — otherwise this and that control both
   * render, stacked at slightly different positions. Defaults to true so
   * existing callers with no close control of their own keep one.
   */
  showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent(
  { style, children, showCloseButton = true, ...props },
  ref,
) {
  return (
    <DialogPortal>
      <DialogOverlay>
        <DialogPrimitive.Content
          ref={ref}
          aria-modal="true"
          style={{ ...contentStyle, ...style }}
          {...props}
        >
          {showCloseButton && (
            <DialogPrimitive.Close style={closeButtonStyle} aria-label="Close">
              ✕
            </DialogPrimitive.Close>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 16,
        ...style,
      }}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ style, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      style={{
        fontSize: 16,
        fontWeight: 700,
        color: TOKENS.textPrimary,
        margin: 0,
        ...style,
      }}
      {...props}
    />
  );
});
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ style, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      style={{
        fontSize: 13,
        color: TOKENS.textMuted,
        marginTop: 4,
        ...style,
      }}
      {...props}
    />
  );
});
DialogDescription.displayName = DialogPrimitive.Description.displayName;

function DialogFooter({
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 10,
        marginTop: 20,
        ...style,
      }}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
