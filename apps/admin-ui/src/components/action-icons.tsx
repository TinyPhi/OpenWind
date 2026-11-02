import React from "react";

type IconProps = { size?: number };

function Svg({
  size = 18,
  children,
}: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function TickIcon(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

export function PauseIcon(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Svg>
  );
}

export function EditIcon(props: IconProps): React.ReactElement {
  return (
    <Svg {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </Svg>
  );
}

const CIRCLE_COLORS = {
  grey: "hsl(222, 10%, 42%)",
  green: "hsl(145, 60%, 38%)",
  yellow: "hsl(45, 95%, 52%)",
  red: "hsl(0, 70%, 48%)",
} as const;

// A fixed icon colour per background, not the theme's text colour: the theme's text colour is near
// white in dark mode, which is unreadable on the bright yellow. White passes on the other three.
const ICON_COLORS = {
  grey: "#fff",
  green: "#fff",
  yellow: "#1a1a1a",
  red: "#fff",
} as const;

export interface CircleActionButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "color"
> {
  color: keyof typeof CIRCLE_COLORS;
  label: string;
  icon: React.ReactNode;
  /** Diameter in px; the roster modal uses the default, table rows a smaller one. */
  size?: number;
}

/** Round action button: coloured background, icon in a colour that reads on it. */
export function CircleActionButton({
  color,
  label,
  icon,
  size = 40,
  style,
  disabled,
  ...rest
}: CircleActionButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        border: "none",
        background: CIRCLE_COLORS[color],
        color: ICON_COLORS[color],
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        ...style,
      }}
    >
      {icon}
    </button>
  );
}
