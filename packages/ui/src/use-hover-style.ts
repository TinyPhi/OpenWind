import * as React from "react";

/**
 * Replaces the hand-rolled onMouseEnter/onMouseLeave pattern that mutated
 * e.currentTarget.style directly (see users.tsx pre-migration) with the same
 * state-driven approach button.tsx already uses. base/hover are per-call-site
 * because they aren't symmetric in practice: some callers reset a property to
 * "" (unset) on leave, others reset it to an explicit value.
 */
export interface UseHoverStyleOptions {
  base: React.CSSProperties;
  hover: React.CSSProperties;
}

export interface HoverStyleProps {
  style: React.CSSProperties;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: (e: React.MouseEvent) => void;
}

export function useHoverStyle({
  base,
  hover,
}: UseHoverStyleOptions): HoverStyleProps {
  const [hovered, setHovered] = React.useState(false);

  return {
    style: hovered ? { ...base, ...hover } : base,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
}
