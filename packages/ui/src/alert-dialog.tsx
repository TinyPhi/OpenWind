import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { TOKENS } from "./tokens.js";

/** See dialog.tsx's header comment — same design-token contract applies here. */

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogTrigger = AlertDialogPrimitive.Trigger;
const AlertDialogPortal = AlertDialogPrimitive.Portal;

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

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(function AlertDialogOverlay({ style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Overlay
      ref={ref}
      style={{ ...overlayStyle, ...style }}
      {...props}
    />
  );
});

const contentStyle: React.CSSProperties = {
  background: TOKENS.bgSecondary,
  border: `1px solid ${TOKENS.borderColor}`,
  borderRadius: TOKENS.radiusLg,
  width: "100%",
  maxWidth: 440,
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: TOKENS.shadowLg,
  padding: "20px 24px",
};

const ALERT_DIALOG_STYLES_ID = "ow-alert-dialog-styles";
const ALERT_DIALOG_STYLES = `
  .ow-alert-action:hover { filter: brightness(0.9); }
  .ow-alert-action:focus-visible { outline: 2px solid ${TOKENS.ring}; outline-offset: 2px; }
  .ow-alert-cancel:hover { background: ${TOKENS.mutedHover}; }
  .ow-alert-cancel:focus-visible { outline: 2px solid ${TOKENS.ring}; outline-offset: 2px; }
`;

function injectAlertDialogStyles(): void {
  if (typeof document === "undefined") return;
  if (!document.getElementById(ALERT_DIALOG_STYLES_ID)) {
    const styleEl = document.createElement("style");
    styleEl.id = ALERT_DIALOG_STYLES_ID;
    styleEl.textContent = ALERT_DIALOG_STYLES;
    document.head.appendChild(styleEl);
  }
}

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(function AlertDialogContent({ style, children, ...props }, ref) {
  React.useEffect(() => {
    injectAlertDialogStyles();
  }, []);

  return (
    <AlertDialogPortal>
      <AlertDialogOverlay>
        <AlertDialogPrimitive.Content
          ref={ref}
          aria-modal="true"
          style={{ ...contentStyle, ...style }}
          {...props}
        >
          {children}
        </AlertDialogPrimitive.Content>
      </AlertDialogOverlay>
    </AlertDialogPortal>
  );
});
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

function AlertDialogHeader({
  style,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div style={{ marginBottom: 12, ...style }} {...props} />;
}

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(function AlertDialogTitle({ style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Title
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
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(function AlertDialogDescription({ style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Description
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
AlertDialogDescription.displayName =
  AlertDialogPrimitive.Description.displayName;

function AlertDialogFooter({
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

const buttonBaseStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: TOKENS.radiusSm,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  transition: TOKENS.transitionFast,
  border: "1px solid transparent",
};

const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(function AlertDialogAction({ className, style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Action
      ref={ref}
      className={["ow-alert-action", className].filter(Boolean).join(" ")}
      style={{
        ...buttonBaseStyle,
        background: TOKENS.danger,
        color: "hsl(0, 0%, 100%)",
        ...style,
      }}
      {...props}
    />
  );
});
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(function AlertDialogCancel({ className, style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Cancel
      ref={ref}
      className={["ow-alert-cancel", className].filter(Boolean).join(" ")}
      style={{
        ...buttonBaseStyle,
        background: "transparent",
        color: TOKENS.textPrimary,
        borderColor: TOKENS.borderColor,
        ...style,
      }}
      {...props}
    />
  );
});
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;

export {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
