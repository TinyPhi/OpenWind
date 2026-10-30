import React, { useRef, useState } from "react";
import { useOutsideClick } from "../hooks/use-outside-click.js";

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface SearchableMultiSelectProps {
  options: MultiSelectOption[];
  /** Chosen values, in the order they were picked. */
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  ariaLabel: string;
  /** Picking beyond this many is refused. */
  max?: number;
  disabled?: boolean;
}

/**
 * Dropdown with a search box and a checkbox per option. Newly ticked options
 * are appended, so `selected` keeps the order people were picked in.
 */
export function SearchableMultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select…",
  ariaLabel,
  max,
  disabled,
}: SearchableMultiSelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useOutsideClick(containerRef, () => {
    if (open) setOpen(false);
  });

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((o) => o.label.toLowerCase().includes(needle))
    : options;
  const atMax = max !== undefined && selected.length >= max;

  function toggle(value: string): void {
    if (selected.includes(value)) onChange(selected.filter((v) => v !== value));
    else if (!atMax) onChange([...selected, value]);
  }

  return (
    <div ref={containerRef}>
      <button
        type="button"
        className="form-input"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ textAlign: "left", cursor: "pointer" }}
      >
        {selected.length === 0 ? placeholder : `${selected.length} selected`}
      </button>
      {open && (
        <div
          style={{
            marginTop: 4,
            background: "var(--bg-secondary, hsl(222, 15%, 18%))",
            border: "1px solid var(--border-color, hsla(222, 12%, 40%, 0.35))",
            borderRadius: "var(--radius-sm, 6px)",
            color: "var(--text-primary, inherit)",
            padding: 8,
          }}
        >
          <input
            className="form-input"
            type="text"
            placeholder="Search…"
            aria-label={`${ariaLabel} search`}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 6 }}>
            {shown.length === 0 ? (
              <p className="page-subtitle" style={{ margin: 4 }}>
                No matches
              </p>
            ) : (
              shown.map((o) => {
                const checked = selected.includes(o.value);
                return (
                  <label
                    key={o.value}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "4px 2px",
                      cursor: "pointer",
                      opacity: !checked && atMax ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && atMax}
                      onChange={() => toggle(o.value)}
                    />
                    {o.label}
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
