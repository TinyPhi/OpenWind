import * as React from "react";

/**
 * Mirrors apps/admin-ui/src/index.css's .btn-primary/.btn-secondary/.btn-sm/
 * .btn-danger-sm rules (see docs/specs/packages-ui-button-primitive.md §V for
 * the one intentional deviation: .btn-primary-sm's separate padding rule is
 * dropped in favor of the .btn-primary.btn-sm value). Hover is tracked via
 * local state rather than a stylesheet — this package ships no CSS of its
 * own (tsc-only build, see dialog.tsx).
 */

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "default" | "sm";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  borderRadius: "var(--radius-sm, 8px)",
  fontWeight: 600,
  cursor: "pointer",
  transition: "var(--transition-fast, all 0.15s ease)",
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
      onMouseEnter,
      onMouseLeave,
      ...props
    },
    ref,
  ) {
    const [hovered, setHovered] = React.useState(false);

    return (
      <button
        ref={ref}
        disabled={disabled}
        style={{
          ...baseStyle,
          ...sizeStyle[size],
          ...variantStyle[variant],
          ...(hovered && !disabled ? variantHoverStyle[variant] : null),
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
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
