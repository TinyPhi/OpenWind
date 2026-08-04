/**
 * Single source of truth for the CSS custom-property names + fallback
 * values every packages/ui component reads. Before this module existed,
 * each component (button.tsx, dialog.tsx, alert-dialog.tsx, icon-button.tsx)
 * hardcoded its own literal copy of e.g. `var(--text-muted, hsl(222, 8%,
 * 56%))` -- invisible duplication that had already drifted once in
 * practice: button.tsx's `--radius-sm` fallback was `8px` while every other
 * caller (and apps/admin-ui/src/index.css's actual `:root` definition) used
 * `6px`. Fixed here to the canonical value.
 *
 * This package still ships no CSS of its own (tsc-only build) -- these are
 * just the `var(--name, fallback)` strings ready to drop into an inline
 * `style` object or a template-literal stylesheet, not a stylesheet
 * themselves. Fallback values mirror apps/admin-ui/src/index.css's dark
 * theme so components still render sensibly in a consumer with no tokens
 * defined at all.
 */

export const TOKENS = {
  accentGradient:
    "var(--accent-gradient, linear-gradient(135deg, hsl(250, 84%, 66%), hsl(265, 84%, 66%)))",
  accentPrimary: "var(--accent-primary, hsl(250, 84%, 66%))",
  bgElevated: "var(--bg-elevated, hsl(222, 15%, 22%))",
  bgSecondary: "var(--bg-secondary, hsl(222, 15%, 18%))",
  bgTertiary: "var(--bg-tertiary, hsl(222, 14%, 23%))",
  borderColor: "var(--border-color, hsla(222, 12%, 40%, 0.35))",
  borderFocus: "var(--border-focus, hsla(250, 84%, 66%, 0.35))",
  danger: "var(--danger, hsl(350, 80%, 60%))",
  // --muted-hover is never defined in index.css (any theme) -- its old
  // hardcoded fallback (hsl(210, 40%, 90%), near-white) put unreadable
  // near-white AlertDialogCancel text on a near-white hover background
  // (PR #320 review). Reuses bgTertiary's fallback instead of inventing
  // another undefined-token literal.
  mutedHover: "var(--muted-hover, hsl(222, 14%, 23%))",
  radiusLg: "var(--radius-lg, 20px)",
  radiusSm: "var(--radius-sm, 6px)",
  ring: "var(--ring, hsl(215, 90%, 60%))",
  shadowLg: "var(--shadow-lg, 0 16px 48px rgba(0, 0, 0, 0.6))",
  textMuted: "var(--text-muted, hsl(222, 8%, 56%))",
  textPrimary: "var(--text-primary, hsl(0, 0%, 94%))",
  textSecondary: "var(--text-secondary, hsl(222, 10%, 75%))",
  transitionFast: "var(--transition-fast, 0.15s ease)",
} as const;
