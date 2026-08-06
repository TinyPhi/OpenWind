import * as React from "react";
import { TOKENS } from "./tokens.js";

/**
 * Mirrors apps/admin-ui/src/index.css's .icon-btn/.icon-btn-edit/
 * .icon-btn-delete/.icon-btn-ghost rules. `.btn-icon`/`.btn-edit-sm` are
 * intentionally NOT covered here — see docs/specs/packages-ui-button-primitive.md
 * §C (deferred, 1 usage each). :focus-visible is approximated with onFocus
 * (fires on mouse-click focus too, not just keyboard) — a known, accepted
 * simplification since this package has no CSS pipeline to express the real
 * pseudo-class.
 */

export type IconButtonVariant = "default" | "edit" | "delete" | "ghost";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: IconButtonVariant;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  borderRadius: "50%",
  border: "1px solid transparent",
  background: "transparent",
  cursor: "pointer",
  transition: "background 0.15s, border-color 0.15s, transform 0.12s",
  flexShrink: 0,
  padding: 0,
  outline: "none",
};

const variantStyle: Record<IconButtonVariant, React.CSSProperties> = {
  default: {},
  edit: {
    color: "hsl(210, 80%, 65%)",
    background: "hsla(210, 80%, 55%, 0.08)",
    borderColor: "hsla(210, 80%, 55%, 0.2)",
  },
  delete: {
    color: TOKENS.danger,
    background: "hsla(350, 80%, 60%, 0.08)",
    borderColor: "hsla(350, 80%, 60%, 0.2)",
  },
  ghost: {
    color: TOKENS.textMuted,
    background: "transparent",
    borderColor: "transparent",
  },
};

const variantHoverStyle: Record<IconButtonVariant, React.CSSProperties> = {
  default: {},
  edit: {
    background: "hsla(210, 80%, 55%, 0.18)",
    borderColor: "hsla(210, 80%, 55%, 0.35)",
  },
  delete: {
    background: "hsla(350, 80%, 60%, 0.18)",
    borderColor: "hsla(350, 80%, 60%, 0.35)",
  },
  ghost: {
    background: TOKENS.bgTertiary,
    color: TOKENS.textSecondary,
  },
};

const focusStyle: React.CSSProperties = {
  boxShadow: `0 0 0 3px ${TOKENS.borderFocus}`,
};

const activeStyle: React.CSSProperties = {
  transform: "scale(0.88)",
};

const disabledStyle: React.CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
  pointerEvents: "none",
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      variant = "default",
      style,
      disabled,
      onMouseEnter,
      onMouseLeave,
      onFocus,
      onBlur,
      onMouseDown,
      onMouseUp,
      ...props
    },
    ref,
  ) {
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [active, setActive] = React.useState(false);

    return (
      <button
        ref={ref}
        disabled={disabled}
        style={{
          ...baseStyle,
          ...variantStyle[variant],
          ...(hovered && !disabled ? variantHoverStyle[variant] : null),
          ...(focused && !disabled ? focusStyle : null),
          ...(active && !disabled ? activeStyle : null),
          ...(disabled ? disabledStyle : null),
          ...style,
        }}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          setActive(false);
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
        onMouseDown={(e) => {
          setActive(true);
          onMouseDown?.(e);
        }}
        onMouseUp={(e) => {
          setActive(false);
          onMouseUp?.(e);
        }}
        {...props}
      />
    );
  },
);
IconButton.displayName = "IconButton";
