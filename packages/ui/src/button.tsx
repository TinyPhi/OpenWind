import * as React from "react";
import { Slot } from "@radix-ui/react-slot";

/**
 * Mirrors apps/admin-ui/src/index.css's .btn-primary/.btn-secondary/.btn-sm/
 * .btn-danger-sm rules (see docs/specs/packages-ui-button-primitive.md §V for
 * the one intentional deviation: .btn-primary-sm's separate padding rule is
 * dropped in favor of the .btn-primary.btn-sm value). Hover/focus are tracked
 * via local state rather than a stylesheet — this package ships no CSS of its
 * own (tsc-only build, see dialog.tsx). :focus-visible is approximated with
 * onFocus (fires on mouse-click focus too, not just keyboard) — same known,
 * accepted simplification as IconButton.
 */

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "default" | "sm";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Render Button's variant/size styling onto a single child element (e.g.
   * <Link>) instead of a real <button> — for call sites that need a
   * non-button tag's semantics (routing, href) with Button's visuals.
   */
  asChild?: boolean;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  borderRadius: "var(--radius-sm, 8px)",
  fontWeight: 600,
  cursor: "pointer",
  transition: "var(--transition-fast, all 0.15s ease)",
  outline: "none",
};

const focusStyle: React.CSSProperties = {
  boxShadow: "0 0 0 3px var(--border-focus, hsla(250, 84%, 66%, 0.35))",
};

const sizeStyle: Record<ButtonSize, React.CSSProperties> = {
  default: { padding: "8px 16px", fontSize: 13 },
  sm: { padding: "5px 12px", fontSize: 12 },
};

const variantStyle: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    border: "none",
    background:
      "var(--accent-gradient, linear-gradient(135deg, hsl(250, 84%, 66%), hsl(265, 84%, 66%)))",
    color: "white",
    boxShadow: "0 2px 8px hsla(250, 84%, 66%, 0.2)",
  },
  secondary: {
    border: "1px solid var(--border-color, hsla(222, 12%, 40%, 0.35))",
    background: "var(--bg-elevated, hsl(222, 15%, 22%))",
    color: "var(--text-secondary, hsl(222, 10%, 75%))",
  },
  danger: {
    border: "1px solid hsla(350, 80%, 60%, 0.3)",
    background: "hsla(350, 80%, 60%, 0.1)",
    color: "var(--danger, hsl(350, 80%, 60%))",
  },
};

const variantHoverStyle: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    boxShadow: "0 4px 12px hsla(250, 84%, 66%, 0.35)",
    transform: "translateY(-1px)",
  },
  secondary: {
    borderColor: "var(--accent-primary, hsl(250, 84%, 66%))",
    color: "var(--accent-primary, hsl(250, 84%, 66%))",
  },
  danger: {
    background: "hsla(350, 80%, 60%, 0.2)",
  },
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
  transform: "none",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "default",
      style,
      disabled,
      asChild = false,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      ...props
    },
    ref,
  ) {
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        ref={ref}
        disabled={asChild ? undefined : disabled}
        style={{
          ...baseStyle,
          ...sizeStyle[size],
          ...variantStyle[variant],
          ...(hovered && !disabled ? variantHoverStyle[variant] : null),
          ...(focused && !disabled ? focusStyle : null),
          ...(disabled ? disabledStyle : null),
          ...style,
        }}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          onMouseLeave?.(e);
        }}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
