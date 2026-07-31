import * as React from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

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
  background: "var(--bg-secondary, hsl(222, 15%, 18%))",
  border: "1px solid var(--border-color, hsla(222, 12%, 40%, 0.35))",
  borderRadius: "var(--radius-lg, 20px)",
  width: "100%",
  maxWidth: 440,
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: "var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.6))",
  padding: "20px 24px",
};

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content>
>(function AlertDialogContent({ style, children, ...props }, ref) {
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
        color: "var(--text-primary, hsl(0, 0%, 94%))",
        margin: 0,
        ...style,
      }}
      {...props}
    />
  );
});

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(function AlertDialogDescription({ style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Description
      ref={ref}
      style={{
        fontSize: 13,
        color: "var(--text-muted, hsl(222, 8%, 56%))",
        marginTop: 4,
        ...style,
      }}
      {...props}
    />
  );
});

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
  borderRadius: "var(--radius-sm, 6px)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  transition: "var(--transition-fast, 0.15s ease)",
  border: "1px solid transparent",
};

const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action>
>(function AlertDialogAction({ style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Action
      ref={ref}
      style={{
        ...buttonBaseStyle,
        background: "var(--danger, hsl(350, 80%, 60%))",
        color: "hsl(0, 0%, 100%)",
        ...style,
      }}
      {...props}
    />
  );
});

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(function AlertDialogCancel({ style, ...props }, ref) {
  return (
    <AlertDialogPrimitive.Cancel
      ref={ref}
      style={{
        ...buttonBaseStyle,
        background: "transparent",
        color: "var(--text-primary, hsl(0, 0%, 94%))",
        borderColor: "var(--border-color, hsla(222, 12%, 40%, 0.35))",
        ...style,
      }}
      {...props}
    />
  );
});

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
