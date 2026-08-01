import React, { useEffect, useRef, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { useEntityTypes } from "../entity-type-context.js";

/**
 * Searchable single-entity picker for `entity_ref` fields (#197). Entity
 * instances have no universal display field, so labels fall back through a
 * short list of common naming fields before showing a truncated id.
 */

type SearchResultInstance = {
  id: string;
  fields: Record<string, unknown>;
};

const LABEL_FIELD_CANDIDATES = ["title", "name", "subject", "label"];

function labelFor(instance: SearchResultInstance): string {
  for (const key of LABEL_FIELD_CANDIDATES) {
    const v = instance.fields[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return `#${instance.id.slice(0, 8)}`;
}

export interface EntityRefPickerProps {
  targetEntityTypeName: string;
  value: string | null;
  onChange: (entityId: string | null) => void;
  classPrefix?: "portal" | "form";
  disabled?: boolean;
}

export function EntityRefPicker({
  targetEntityTypeName,
  value,
  onChange,
  classPrefix = "form",
  disabled,
}: EntityRefPickerProps): React.ReactElement {
  const { entityTypes } = useEntityTypes();
  const targetType = entityTypes.find((t) => t.name === targetEntityTypeName);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultInstance[]>([]);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!value) {
      setSelectedLabel(null);
      return;
    }
    let cancelled = false;
    void fetchWithAuth(`${API_URL}/entities/${value}`)
      .then((res) => {
        if (cancelled) return;
        const instance = (res as { data: SearchResultInstance }).data;
        setSelectedLabel(labelFor(instance));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [value]);

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

  function handleQueryChange(next: string): void {
    setQuery(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!targetType || next.trim().length === 0) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      fetchWithAuth(
        `${API_URL}/entities/search?type=${targetType.id}&q=${encodeURIComponent(next)}&limit=10`,
      )
        .then((res) => {
          const page = (res as { data: { data: SearchResultInstance[] } }).data;
          setResults(page.data);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 250);
  }

  function select(instance: SearchResultInstance | null): void {
    onChange(instance?.id ?? null);
    setSelectedLabel(instance ? labelFor(instance) : null);
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  if (!targetType) {
    return (
      <input
        className={`${classPrefix}-input`}
        type="text"
        disabled
        value={`Unknown entity type: ${targetEntityTypeName}`}
      />
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        className={`${classPrefix}-input`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ textAlign: "left", cursor: "pointer" }}
      >
        {value ? (selectedLabel ?? `#${value.slice(0, 8)}`) : "Select…"}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 20,
            background: "var(--bg-secondary, hsl(222, 15%, 18%))",
            border: "1px solid var(--border-color, hsla(222, 12%, 40%, 0.35))",
            borderRadius: "var(--radius-sm, 6px)",
            marginTop: 4,
            maxHeight: 280,
            overflowY: "auto",
            boxShadow: "var(--shadow-md, 0 8px 24px rgba(0,0,0,0.5))",
          }}
        >
          <input
            autoFocus
            className={`${classPrefix}-input`}
            style={{ margin: 8, width: "calc(100% - 16px)" }}
            placeholder={`Search ${targetType.plural.toLowerCase()}…`}
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
          />
          <button
            type="button"
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted, hsl(222, 8%, 56%))",
            }}
            onClick={() => select(null)}
          >
            Clear
          </button>
          {loading && (
            <div style={{ padding: "8px 12px", color: "var(--text-muted)" }}>
              Searching…
            </div>
          )}
          {!loading && query.trim() !== "" && results.length === 0 && (
            <div style={{ padding: "8px 12px", color: "var(--text-muted)" }}>
              No matches
            </div>
          )}
          {!loading &&
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
                onClick={() => select(r)}
              >
                {labelFor(r)}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
