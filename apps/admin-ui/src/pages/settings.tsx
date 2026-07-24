import React, { useEffect, useState } from "react";
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
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager } from "../authProvider.js";

type ModuleRow = {
  slug: string;
  name: string;
  isVisible: boolean;
};

export function Settings(): React.ReactElement {
  const [theme, setTheme] = useState<ThemeMode>(getSavedTheme);
  const [accent, setAccent] = useState<AccentColor>(getSavedAccent);

  const [appearanceOpen, setAppearanceOpen] = useState(true);
  const [templatesOpen, setTemplatesOpen] = useState(true);

  const [isAdmin, setIsAdmin] = useState(false);
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [templateModules, setTemplateModules] = useState<ModuleRow[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [togglingSlug, setTogglingSlug] = useState<string | null>(null);

  useEffect(() => {
    void userManager.getUser().then((u) => {
      if (!u) {
        setRoleLoaded(true);
        return;
      }
      const roleClaim = u.profile["urn:zitadel:iam:org:project:roles"] as
        | Record<string, unknown>
        | undefined;
      const roles = roleClaim ? Object.keys(roleClaim) : [];
      setIsAdmin(roles.includes("admin"));
      setRoleLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!roleLoaded || !isAdmin) return;
    setTemplatesLoading(true);
    void fetchWithAuth(`${API_URL}/modules?includeHidden=true`)
      .then((res) => {
        const list = (res as { data?: ModuleRow[] }).data ?? [];
        setTemplateModules(list);
      })
      .finally(() => setTemplatesLoading(false));
  }, [roleLoaded, isAdmin]);

  async function toggleVisibility(slug: string, next: boolean): Promise<void> {
    setTogglingSlug(slug);
    // Optimistic update — reverted if the request fails.
    setTemplateModules((list) =>
      list.map((m) => (m.slug === slug ? { ...m, isVisible: next } : m)),
    );
    try {
      await fetchWithAuth(`${API_URL}/modules/${slug}/visibility`, {
        method: "PATCH",
        body: JSON.stringify({ isVisible: next }),
      });
    } catch {
      setTemplateModules((list) =>
        list.map((m) => (m.slug === slug ? { ...m, isVisible: !next } : m)),
      );
    } finally {
      setTogglingSlug(null);
    }
  }

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
        <button
          type="button"
          className="settings-section-header settings-section-header-toggle"
          onClick={() => setAppearanceOpen((v) => !v)}
          aria-expanded={appearanceOpen}
        >
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
          <div className="settings-section-header-text">
            <h2 className="settings-section-title">Appearance</h2>
            <p className="settings-section-desc">
              Customize how OpenWind looks on your screen
            </p>
          </div>
          <svg
            className={`settings-section-chevron ${appearanceOpen ? "settings-section-chevron-open" : ""}`}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {appearanceOpen && (
          <div className="settings-section-body">
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
          </div>
        )}
      </section>

      {/* Templates — admin only. Global, platform-wide toggle for which
          templates appear in every tenant's Templates page. */}
      {isAdmin && (
        <section className="data-panel settings-section">
          <button
            type="button"
            className="settings-section-header settings-section-header-toggle"
            onClick={() => setTemplatesOpen((v) => !v)}
            aria-expanded={templatesOpen}
          >
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
                  d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
                />
              </svg>
            </div>
            <div className="settings-section-header-text">
              <h2 className="settings-section-title">Templates</h2>
              <p className="settings-section-desc">
                Admin only — control which templates appear on the Templates
                page for everyone across all tenants.
              </p>
            </div>
            <svg
              className={`settings-section-chevron ${templatesOpen ? "settings-section-chevron-open" : ""}`}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {templatesOpen && (
            <div className="settings-section-body">
              {templatesLoading ? (
                <div className="settings-field">
                  <span className="settings-field-hint">
                    Loading templates…
                  </span>
                </div>
              ) : (
                templateModules.map((m) => (
                  <div
                    className="settings-field"
                    key={m.slug}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "16px",
                    }}
                  >
                    <div className="settings-field-label">
                      <span>{m.name}</span>
                      <span className="settings-field-hint">
                        {m.isVisible
                          ? "Visible on the Templates page for everyone"
                          : "Hidden — no tenant can see or install this template"}
                      </span>
                    </div>
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={m.isVisible}
                        disabled={togglingSlug === m.slug}
                        onChange={(e) =>
                          void toggleVisibility(m.slug, e.target.checked)
                        }
                      />
                      <span className="settings-toggle-track" />
                    </label>
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
