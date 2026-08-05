import React from "react";
import { useTranslation } from "react-i18next";
import { userManager } from "../authProvider.js";

function SunIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function Login(): React.ReactElement {
  const { t } = useTranslation();
  const [loading, setLoading] = React.useState(false);
  const [theme, setTheme] = React.useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("ow-theme");
    if (stored === "light" || stored === "dark") return stored;
    return "dark";
  });

  // Keep <html data-theme> in sync
  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("ow-theme", theme);
  }, [theme]);

  function toggleTheme(): void {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  async function handleLogin(): Promise<void> {
    setLoading(true);
    await userManager.removeUser();
    await userManager.signinRedirect({ prompt: "login" });
  }

  const isDark = theme === "dark";

  return (
    <div className="lp-page" data-theme={theme}>
      {/* ── Top bar ── */}
      <header className="lp-topbar">
        <div className="lp-topbar-inner">
          {/* Brand */}
          <div className="lp-brand">
            <div className="lp-brand-logo">W</div>
            <span className="lp-brand-name">{t("login.brandName")}</span>
          </div>

          {/* Theme toggle */}
          <button
            className="lp-theme-btn"
            onClick={toggleTheme}
            aria-label={
              isDark
                ? t("login.theme.switchToLight")
                : t("login.theme.switchToDark")
            }
            title={
              isDark
                ? t("login.theme.switchToLight")
                : t("login.theme.switchToDark")
            }
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
            <span>
              {isDark ? t("login.theme.light") : t("login.theme.dark")}
            </span>
          </button>
        </div>

        {/* Bottom accent line */}
        <div className="lp-topbar-accent" />
      </header>

      {/* ── Main ── */}
      <main className="lp-main">
        <div className="lp-card">
          {/* Card header */}
          <div className="lp-card-head">
            <div className="lp-card-logo">W</div>
            <h1 className="lp-card-title">{t("login.title")}</h1>
            <p className="lp-card-desc">{t("login.description")}</p>
          </div>

          <div className="lp-card-divider" />

          {/* SSO section */}
          <div className="lp-card-body">
            <button
              className="lp-signin-btn"
              onClick={() => void handleLogin()}
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="lp-spinner" aria-hidden="true" />
                  {t("login.redirecting")}
                </>
              ) : (
                <>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="18"
                    height="18"
                    aria-hidden="true"
                  >
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <polyline points="10 17 15 12 10 7" />
                    <line x1="15" y1="12" x2="3" y2="12" />
                  </svg>
                  {t("login.signInButton")}
                </>
              )}
            </button>
          </div>

          {/* Security badge */}
          <div className="lp-security">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            {t("login.securityNote")}
          </div>
        </div>

        <p className="lp-help">
          {t("login.helpPrompt")}{" "}
          <a href="mailto:support@openwind.io" className="lp-help-link">
            {t("login.contactAdmin")}
          </a>
        </p>
      </main>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <span>{t("login.footer.copyright")}</span>
          <span className="lp-footer-sep">·</span>
          <a
            href="https://github.com/openwind"
            className="lp-footer-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("login.footer.github")}
          </a>
          <span className="lp-footer-sep">·</span>
          <a href="#" className="lp-footer-link">
            {t("login.footer.docs")}
          </a>
          <span className="lp-footer-sep">·</span>
          <a href="#" className="lp-footer-link">
            {t("login.footer.privacy")}
          </a>
        </div>
      </footer>
    </div>
  );
}
