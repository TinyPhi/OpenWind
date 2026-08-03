import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { TOKENS } from "./tokens.js";

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
   * Radix Slot requires exactly one child element; more or fewer throws
   * at render time.
   */
  asChild?: boolean;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  borderRadius: TOKENS.radiusSm,
  fontWeight: 600,
  cursor: "pointer",
  transition: TOKENS.transitionFast,
  outline: "none",
};

const focusStyle: React.CSSProperties = {
  boxShadow: `0 0 0 3px ${TOKENS.borderFocus}`,
};

const sizeStyle: Record<ButtonSize, React.CSSProperties> = {
  default: { padding: "8px 16px", fontSize: 13 },
  sm: { padding: "5px 12px", fontSize: 12 },
};

const variantStyle: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    border: "none",
    background: TOKENS.accentGradient,
    color: "white",
    boxShadow: "0 2px 8px hsla(250, 84%, 66%, 0.2)",
  },
  secondary: {
    border: `1px solid ${TOKENS.borderColor}`,
    background: TOKENS.bgElevated,
    color: TOKENS.textSecondary,
  },
  danger: {
    border: "1px solid hsla(350, 80%, 60%, 0.3)",
    background: "hsla(350, 80%, 60%, 0.1)",
    color: TOKENS.danger,
  },
};

const variantHoverStyle: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    boxShadow: "0 4px 12px hsla(250, 84%, 66%, 0.35)",
    transform: "translateY(-1px)",
  },
  secondary: {
    borderColor: TOKENS.accentPrimary,
    color: TOKENS.accentPrimary,
  },
  danger: {
    background: "hsla(350, 80%, 60%, 0.2)",
  },
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
  transform: "none",
  // Load-bearing for asChild: Radix Slot always invokes a child's own click
  // handler (e.g. <Link>'s internal navigate) before this component's, so a
  // JS-level guard alone can never stop it. pointer-events: none blocks the
  // click at the browser's hit-testing level instead, before any handler —
  // ours or the child's own — ever runs.
  pointerEvents: "none",
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
      onClick,
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
        aria-disabled={asChild && disabled ? true : undefined}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          if (disabled) {
            // Defense-in-depth alongside pointerEvents: "none" above (the
            // actual click-blocker for asChild — see disabledStyle). This
            // covers keyboard-triggered clicks and still reliably prevents
            // the default action (e.g. an <a>'s href navigation) even though
            // Slot always runs the child's own handler first.
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          onClick?.(e);
        }}
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
