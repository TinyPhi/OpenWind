import React from "react";

// docs/specs/third-party-api-origin-tagging.md — the API response shape
// resolve-origin-display.ts (apps/api/src/lib) produces, attached as
// `origin` on ticket/comment/activity-timeline responses. Null means
// normal, human, in-app creation — no tag rendered (spec §V).
// performerDisplayName is the live-resolved Zitadel display name/username
// for performerUserId (falls back to the raw id server-side if the user
// can't be resolved, e.g. deactivated) — always prefer it over the raw id.
export type Origin =
  | {
      mechanism: "api" | "handoff";
      appName: string;
      performerUserId: string;
      performerDisplayName?: string;
    }
  | null
  | undefined;

// Exported so the records-list "Source" filter (workflow-records.tsx) can
// render its own option chips in the same colors/labels as the badges
// they filter for, instead of picking an unrelated palette.
export const LABEL_BY_MECHANISM: Record<"api" | "handoff", string> = {
  api: "External",
  handoff: "Redirected",
};

// Distinct per-mechanism hue so "External" (unmediated third-party write)
// and "Redirected" (hosted handoff, still a real person) read as different
// at a glance — filled pill, not the muted/plain-text look review flagged.
export const COLOR_BY_MECHANISM: Record<"api" | "handoff", string> = {
  api: "hsl(28, 88%, 52%)",
  handoff: "hsl(250, 84%, 66%)",
};

function performerLabel(origin: NonNullable<Origin>): string {
  return origin.performerDisplayName ?? origin.performerUserId;
}

// hsl(H, S%, L%) -> hsla(H, S%, L%, alpha) — our mechanism colors are
// always plain hsl() strings, so a straight suffix swap is safe here and
// avoids depending on color-mix() for this specific alpha-tint use.
function withAlpha(hslColor: string, alpha: number): string {
  return hslColor.replace("hsl(", "hsla(").replace(")", `, ${alpha})`);
}

/**
 * Small pill badge for a records-list card — label only ("External" /
 * "Redirected"), meant to sit absolutely positioned in a card's top-right
 * corner (see workflow-records.tsx's `.kb-card-origin-corner`). Full
 * app/person detail is available via the title tooltip and, in full, on
 * the ticket-detail page's OriginHeaderPill/OriginDetailLine.
 */
export function OriginCornerBadge({
  origin,
}: {
  origin: Origin;
}): React.ReactElement | null {
  if (!origin) return null;
  const color = COLOR_BY_MECHANISM[origin.mechanism];

  return (
    <span
      className="kb-card-origin-corner"
      title={`${LABEL_BY_MECHANISM[origin.mechanism]} · Created via ${origin.appName} by ${performerLabel(origin)}`}
      style={{
        background: color,
        color: "hsl(0, 0%, 100%)",
      }}
    >
      {LABEL_BY_MECHANISM[origin.mechanism]}
    </span>
  );
}

/**
 * Inline `External · [App] · [Person]` / `Redirected · [App] · [Person]`
 * badge for comment authorship and activity-timeline entries
 * (docs/specs/third-party-api-origin-tagging.md R3/R5). Returns null
 * (renders nothing) when origin is null/undefined — a normal, in-app
 * ticket/comment/timeline entry never carries a tag.
 */
export function OriginTag({
  origin,
  size = "normal",
}: {
  origin: Origin;
  size?: "normal" | "compact";
}): React.ReactElement | null {
  if (!origin) return null;

  const color = COLOR_BY_MECHANISM[origin.mechanism];
  const fontSize = size === "compact" ? "10.5px" : "11.5px";
  const padding = size === "compact" ? "1px 7px" : "2px 9px";

  return (
    <span
      title={`Created via ${origin.appName} by ${performerLabel(origin)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding,
        borderRadius: "999px",
        fontSize,
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        background: `color-mix(in srgb, ${color} 16%, var(--bg-secondary))`,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ color }}>{LABEL_BY_MECHANISM[origin.mechanism]}</span>
      <span aria-hidden="true" style={{ opacity: 0.5 }}>
        ·
      </span>
      <span
        style={{
          maxWidth: "140px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {origin.appName}
      </span>
      <span aria-hidden="true" style={{ opacity: 0.5 }}>
        ·
      </span>
      <span
        style={{
          maxWidth: "120px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {performerLabel(origin)}
      </span>
    </span>
  );
}

/**
 * Ticket-detail header pill — sits inline with StateBadge/the id chip in
 * the card's meta row, matching `.rcd-state-badge`'s exact visual language
 * (10%-alpha tinted background, 25%-alpha border, colored dot + text)
 * rather than standing out as a separate boxed banner.
 */
export function OriginHeaderPill({
  origin,
}: {
  origin: Origin;
}): React.ReactElement | null {
  if (!origin) return null;

  const color = COLOR_BY_MECHANISM[origin.mechanism];

  return (
    <span
      title={`Created via ${origin.appName} by ${performerLabel(origin)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "3px 10px",
        borderRadius: "20px",
        fontSize: "11.5px",
        fontWeight: 600,
        background: withAlpha(color, 0.1),
        color,
        border: `1px solid ${withAlpha(color, 0.25)}`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "currentColor",
          flexShrink: 0,
        }}
      />
      {LABEL_BY_MECHANISM[origin.mechanism]}
    </span>
  );
}

/**
 * Ticket-detail full-detail line (R1/R2) — "Created via [App] by [Person]"
 * as a quiet text row under the title/meta, matching the page's other
 * muted meta text rather than a bordered card.
 */
export function OriginDetailLine({
  origin,
}: {
  origin: Origin;
}): React.ReactElement | null {
  if (!origin) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "5px",
        fontSize: "12px",
        color: "var(--text-muted)",
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, opacity: 0.7 }}
      >
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M9 9h6v6H9z" />
      </svg>
      <span>
        Created via{" "}
        <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
          {origin.appName}
        </strong>{" "}
        by{" "}
        <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
          {performerLabel(origin)}
        </strong>
      </span>
    </div>
  );
}
