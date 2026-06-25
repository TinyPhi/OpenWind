import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface UserOption {
  userId: string;
  displayName: string;
  email: string;
  loginName?: string;
}

interface Props {
  users: UserOption[];
  value: string | null;
  onChange: (userId: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function UserPicker({
  users,
  value,
  onChange,
  placeholder = "Assign to…",
  disabled = false,
}: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = users.find((u) => u.userId === value) ?? null;

  const filtered = query.trim()
    ? users.filter(
        (u) =>
          u.displayName.toLowerCase().includes(query.toLowerCase()) ||
          u.email.toLowerCase().includes(query.toLowerCase()) ||
          (u.loginName ?? "").toLowerCase().includes(query.toLowerCase()),
      )
    : users;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      const target = e.target as Node;
      const inContainer = containerRef.current?.contains(target) ?? false;
      const inDropdown = dropdownRef.current?.contains(target) ?? false;
      if (!inContainer && !inDropdown) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  function initials(name: string): string {
    return name
      .split(" ")
      .slice(0, 2)
      .map((p) => p[0] ?? "")
      .join("")
      .toUpperCase();
  }

  return (
    <div ref={containerRef} style={{ position: "relative", minWidth: "220px" }}>
      {/* Trigger button */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((o) => {
            if (!o && containerRef.current) {
              setDropdownRect(containerRef.current.getBoundingClientRect());
            }
            return !o;
          });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          width: "100%",
          padding: "7px 10px",
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderRadius: "var(--radius-sm)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: "13px",
          color: selected ? "var(--text-primary)" : "var(--text-muted)",
          textAlign: "left",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {selected ? (
          <>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "22px",
                height: "22px",
                borderRadius: "50%",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "10px",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {initials(selected.displayName)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selected.displayName}
            </span>
          </>
        ) : (
          <>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "22px",
                height: "22px",
                borderRadius: "50%",
                background: "var(--bg-tertiary)",
                border: "1px dashed var(--border-color)",
                flexShrink: 0,
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </span>
            <span>{placeholder}</span>
          </>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          style={{ marginLeft: "auto", flexShrink: 0, opacity: 0.5 }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* Dropdown — rendered in a portal so it escapes overflow:hidden parents */}
      {open &&
        dropdownRect &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: dropdownRect.bottom + 4,
              left: dropdownRect.left,
              width: Math.max(dropdownRect.width, 240),
              background: "var(--bg-secondary)",
              border: "1px solid var(--border-color)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-lg)",
              zIndex: 9999,
              overflow: "hidden",
              animation: "popup-in .1s ease",
            }}
          >
            {/* Search box */}
            <div
              style={{
                padding: "8px",
                borderBottom: "1px solid var(--border-color)",
              }}
            >
              <div style={{ position: "relative" }}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{
                    position: "absolute",
                    left: "8px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    opacity: 0.4,
                    pointerEvents: "none",
                  }}
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search users…"
                  style={{
                    width: "100%",
                    padding: "6px 8px 6px 28px",
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "var(--radius-sm)",
                    fontSize: "12px",
                    color: "var(--text-primary)",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            </div>

            {/* Options list */}
            <div style={{ maxHeight: "220px", overflowY: "auto" }}>
              {/* Unassign option */}
              {value !== null && (
                <button
                  type="button"
                  onClick={() => {
                    onChange(null);
                    setOpen(false);
                    setQuery("");
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    padding: "8px 12px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "13px",
                    color: "var(--text-muted)",
                    textAlign: "left",
                    borderBottom: "1px solid var(--border-color)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "var(--bg-tertiary)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "none";
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                  Unassign
                </button>
              )}

              {filtered.length === 0 ? (
                <div
                  style={{
                    padding: "16px 12px",
                    fontSize: "13px",
                    color: "var(--text-muted)",
                    textAlign: "center",
                  }}
                >
                  No users found
                </div>
              ) : (
                filtered.map((u) => (
                  <button
                    key={u.userId}
                    type="button"
                    onClick={() => {
                      onChange(u.userId);
                      setOpen(false);
                      setQuery("");
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      width: "100%",
                      padding: "8px 12px",
                      background:
                        u.userId === value ? "var(--accent-primary)1a" : "none",
                      border: "none",
                      cursor: "pointer",
                      fontSize: "13px",
                      color: "var(--text-primary)",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => {
                      if (u.userId !== value)
                        (
                          e.currentTarget as HTMLButtonElement
                        ).style.background = "var(--bg-tertiary)";
                    }}
                    onMouseLeave={(e) => {
                      if (u.userId !== value)
                        (
                          e.currentTarget as HTMLButtonElement
                        ).style.background = "none";
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "26px",
                        height: "26px",
                        borderRadius: "50%",
                        background:
                          u.userId === value
                            ? "var(--accent-primary)"
                            : "var(--bg-tertiary)",
                        color:
                          u.userId === value ? "#fff" : "var(--text-secondary)",
                        fontSize: "10px",
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {initials(u.displayName)}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 500,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {u.displayName}
                      </div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: "var(--text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {u.email || u.loginName}
                      </div>
                    </div>
                    {u.userId === value && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--accent-primary)"
                        strokeWidth="2.5"
                        style={{ marginLeft: "auto", flexShrink: 0 }}
                      >
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
