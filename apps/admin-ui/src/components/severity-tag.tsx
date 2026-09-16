import React, { useEffect, useRef, useState } from "react";

// docs/specs/ticket-severity-and-tags.md §I — fixed, global, rank-ordered.
// Never tenant-customizable. Rank is array position (low=1 ... critical=4).
export const SEVERITY_LEVELS = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const SEVERITY_LABEL: Record<Severity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

// Same palette convention as origin-tag.tsx's COLOR_BY_MECHANISM — plain
// hsl() strings so withAlpha's string-suffix swap stays valid.
export const SEVERITY_COLOR: Record<Severity, string> = {
  low: "hsl(210, 14%, 55%)",
  medium: "hsl(45, 93%, 47%)",
  high: "hsl(28, 88%, 52%)",
  critical: "hsl(0, 72%, 51%)",
};

export const DEFAULT_SEVERITY: Severity = "medium";

function withAlpha(hslColor: string, alpha: number): string {
  return hslColor.replace("hsl(", "hsla(").replace(")", `, ${alpha})`);
}

/**
 * Read-only colored pill — records-list card corner badge and any place that
 * only needs to display severity, not change it. `severity` is null for
 * tickets created before this feature shipped and never opened in the Edit
 * form since (docs/specs/ticket-severity-and-tags.md §V) — renders nothing
 * in that case, same convention as OriginCornerBadge.
 */
export function SeverityBadge({
  severity,
  compact = false,
}: {
  severity: Severity | null | undefined;
  compact?: boolean;
}): React.ReactElement | null {
  if (!severity) return null;
  const color = SEVERITY_COLOR[severity];

  return (
    <span
      title={`Severity: ${SEVERITY_LABEL[severity]}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: compact ? "1px 7px" : "2px 9px",
        borderRadius: "20px",
        fontSize: compact ? "10.5px" : "11.5px",
        fontWeight: 600,
        background: withAlpha(color, 0.14),
        color,
        border: `1px solid ${withAlpha(color, 0.35)}`,
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
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

/**
 * Editable severity control — same searchable-dropdown-menu shell as
 * AssignDropdown/StateDropdown (record-detail.tsx) for visual consistency,
 * but a fixed 4-item list needs no search box. `value` of null renders as
 * an unset/required state (red-tinted trigger, "Select severity…" label) —
 * docs/specs/ticket-severity-and-tags.md R2: legacy tickets show this until
 * the Edit form is used to set one.
 */
export function SeverityDropdown({
  value,
  disabled,
  required = false,
  onChange,
}: {
  value: Severity | null;
  disabled?: boolean;
  required?: boolean;
  onChange: (severity: Severity) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const color = value ? SEVERITY_COLOR[value] : null;
  const isUnset = value === null;

  return (
    <div ref={containerRef} className="asgn-drop">
      <button
        type="button"
        className={`asgn-trigger asgn-trigger-state ${open ? "asgn-trigger-open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={isUnset ? "Severity is required" : "Change severity"}
        style={
          isUnset && required
            ? {
                borderColor: "var(--danger, #dc2626)",
                color: "var(--danger, #dc2626)",
              }
            : undefined
        }
      >
        <span
          className="rcd-state-dot"
          style={color ? { background: color } : undefined}
        />
        <span className="asgn-name">
          {value ? SEVERITY_LABEL[value] : "Select severity…"}
          {isUnset && required && (
            <span style={{ color: "var(--danger, #dc2626)" }}> *</span>
          )}
        </span>
        <svg
          className="asgn-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="asgn-menu">
          <div className="asgn-options">
            {SEVERITY_LEVELS.map((level) => {
              const levelColor = SEVERITY_COLOR[level];
              return (
                <button
                  key={level}
                  type="button"
                  className={`asgn-option ${value === level ? "asgn-option-selected" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    onChange(level);
                  }}
                >
                  <span
                    className="rcd-state-dot"
                    style={{ background: levelColor }}
                  />
                  <span className="asgn-option-info">
                    <span className="asgn-option-name">
                      {SEVERITY_LABEL[level]}
                    </span>
                  </span>
                  {value === level && (
                    <svg
                      className="asgn-check"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
