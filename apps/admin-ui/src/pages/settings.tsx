import React, { useState } from "react";
import {
  applyTheme,
  applyAccent,
  getSavedTheme,
  getSavedAccent,
  ACCENT_COLORS,
  makeCustomAccent,
  hslToHex,
  type ThemeMode,
  type AccentColor,
} from "../lib/theme.js";

export function Settings(): React.ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(getSavedTheme);
  const [accent, setAccent] = useState<AccentColor>(getSavedAccent);

  function handleTheme(mode: ThemeMode): void {
    setTheme(mode);
    applyTheme(mode);
  }

  function handleAccent(color: AccentColor): void {
    setAccent(color);
    applyAccent(color);
  }

  function handleCustomAccent(hex: string): void {
    const custom = makeCustomAccent(hex);
    setAccent(custom);
    applyAccent(custom);
  }

  return (
    <div className="settings-page" style={{ animation: "fadeIn 0.3s ease" }}>
      {/* Appearance */}
      <section className="data-panel settings-section">
        <div className="settings-section-header">
          <div className="settings-section-icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="2"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
              />
            </svg>
          </div>
          <div>
            <h2 className="settings-section-title">Appearance</h2>
            <p className="settings-section-desc">
              Customize how OpenWind looks on your screen
            </p>
          </div>
        </div>

        {/* Theme toggle */}
        <div className="settings-field">
          <div className="settings-field-label">
            <span>Color mode</span>
            <span className="settings-field-hint">
              Switch between dark and light interface
            </span>
          </div>
          <div className="theme-toggle-group">
            <button
              className={`theme-option ${theme === "dark" ? "active" : ""}`}
              onClick={() => handleTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              <span className="theme-option-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                  />
                </svg>
              </span>
              Dark
            </button>
            <button
              className={`theme-option ${theme === "light" ? "active" : ""}`}
              onClick={() => handleTheme("light")}
              aria-pressed={theme === "light"}
            >
              <span className="theme-option-icon">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                  />
                </svg>
              </span>
              Light
            </button>
          </div>
        </div>

        {/* Accent color */}
        <div className="settings-field">
          <div className="settings-field-label">
            <span>Accent color</span>
            <span className="settings-field-hint">
              Sets the primary highlight color across the UI
            </span>
          </div>
          <div className="color-palette">
            {ACCENT_COLORS.map((color) => (
              <button
                key={color.id}
                className={`color-swatch ${accent.id === color.id ? "selected" : ""}`}
                title={color.label}
                aria-label={color.label}
                aria-pressed={accent.id === color.id}
                onClick={() => handleAccent(color)}
                style={
                  {
                    "--swatch-color": `hsl(${color.h}, ${color.s}%, ${color.l}%)`,
                  } as React.CSSProperties
                }
              />
            ))}
            <label
              className={`color-swatch color-swatch-custom ${accent.id === "custom" ? "selected" : ""}`}
              title="Custom color"
              aria-label="Custom color"
              style={
                {
                  "--swatch-color": `hsl(${accent.h}, ${accent.s}%, ${accent.l}%)`,
                  background:
                    accent.id === "custom"
                      ? `hsl(${accent.h}, ${accent.s}%, ${accent.l}%)`
                      : undefined,
                } as React.CSSProperties
              }
            >
              <input
                type="color"
                value={hslToHex(accent.h, accent.s, accent.l)}
                onChange={(e) => handleCustomAccent(e.target.value)}
                aria-label="Pick a custom accent color"
              />
            </label>
          </div>
          <div className="color-preview">
            <span className="color-preview-name">{accent.label}</span>
            <span
              className="color-preview-swatch"
              style={{
                background: `hsl(${accent.h}, ${accent.s}%, ${accent.l}%)`,
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
