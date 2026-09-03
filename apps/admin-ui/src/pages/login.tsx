import React from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { userManager } from "../authProvider.js";

// Hosted ticket-create handoff (docs/specs/hosted-ticket-create-handoff.md).
// A 3rd party opens this route with these params instead of the bare
// /login -- carried through the OAuth round-trip via oidc-client-ts's
// `state` (not sessionStorage/a server-side cache; state is designed for
// exactly this and survives the full redirect chain automatically).
export interface HandoffState {
  workflowId: string;
  entityTypeId: string;
  prefillFields: Record<string, string>;
}

// RFC 4122 UUID v4 shape used for defence-in-depth validation in
// readHandoffParams below. isHandoffState in callback.tsx also validates,
// but we reject non-UUIDs here so invalid state is never written into the
// OAuth redirect in the first place.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deliberately only ever extracts `title`/`remark` -- never arbitrary query
// params -- because this whole path travels as plain URL query string (into
// oidc-client-ts's `state`, itself embedded in the OAuth redirect chain) and
// is visible in browser history and proxy access logs along the way (spec
// §C). Only low-sensitivity, non-PII fields belong here; adding a generic
// passthrough for arbitrary field names would silently widen that exposure
// without the privacy review this limit was based on.
function readHandoffParams(params: URLSearchParams): HandoffState | undefined {
  const workflowId = params.get("workflowId");
  const entityTypeId = params.get("entityTypeId");
  if (!workflowId || !entityTypeId) return undefined;
  // defence-in-depth: isHandoffState in callback.tsx also validates, but
  // we reject non-UUIDs here so invalid state is never written to the OAuth
  // redirect (fixing issue #544).
  if (!UUID_RE.test(workflowId) || !UUID_RE.test(entityTypeId)) {
    return undefined;
  }
  const prefillFields: Record<string, string> = {};
  const title = params.get("title");
  const remark = params.get("remark");
  if (title) prefillFields["title"] = title;
  if (remark) prefillFields["remark"] = remark;
  return { workflowId, entityTypeId, prefillFields };
}

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
  const [searchParams] = useSearchParams();
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
    try {
      await userManager.removeUser();
      await userManager.signinRedirect({ prompt: "login" });
    } catch {
      // signinRedirect navigates away on success, so this only runs on a
      // genuine failure (IdP unreachable, misconfigured OIDC endpoint) --
      // without resetting loading here, the button stays permanently
      // disabled for the rest of the session with no way to retry.
      setLoading(false);
    }
  }

  async function handleHandoffLogin(handoff: HandoffState): Promise<void> {
    setLoading(true);
    try {
      // Deliberately NO prompt: "login" (unlike handleLogin above) and NO
      // removeUser() -- an already-authenticated caller must be able to
      // reuse their existing session silently and land straight on the
      // pre-filled page, per spec R1, without a forced re-login screen.
      await userManager.signinRedirect({ state: handoff });
    } catch {
      setLoading(false);
    }
  }

  // Deliberately NOT auto-triggered on mount -- the user still sees and
  // clicks this page's own Sign In button, same as the default flow (an
  // earlier version auto-fired signinRedirect here, which skipped straight
  // to Zitadel's hosted login page with no visible OpenWind screen at all;
  // corrected after live testing showed that wasn't the intended UX).
  const handoff = React.useMemo(
    () => readHandoffParams(searchParams),
    [searchParams],
  );
  async function handleSignInClick(): Promise<void> {
    if (handoff) {
      await handleHandoffLogin(handoff);
      return;
    }
    await handleLogin();
  }

  const isDark = theme === "dark";

  return (
    <div className="lp-page lp-page-notebook" data-theme={theme}>
      {/* Logo, floating top-left — no bar chrome, no brand name (the
          sign-in card already names OpenWind) */}
      <div className="lp-float-logo">W</div>

      {/* Theme toggle, floating top-right — icon only, no label */}
      <button
        className="lp-theme-btn lp-float-theme-btn"
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
      </button>

      {/* ── Main ── */}
      <main className="lp-main">
        {/* Soft light source behind the card, tinted with the active accent
            color so it matches whichever theme/accent the user has picked */}
        <div className="lp-card-glow" aria-hidden="true" />
        <div className="lp-card lp-card-notebook">
          {/* Breadcrumb-style header, replacing the stacked logo/title/desc block */}
          <div className="lp-card-head lp-notebook-head">
            <div className="lp-notebook-crumb">
              <span>{t("login.brandName")}</span>
              <span className="lp-notebook-crumb-sep" aria-hidden="true">
                /
              </span>
              <span className="lp-notebook-crumb-current">
                {t("login.signInTag")}
              </span>
            </div>
            <h1 className="lp-card-title lp-notebook-title">
              {t("login.title")}
            </h1>
            <p className="lp-card-desc">{t("login.description")}</p>
          </div>

          {/* SSO section */}
          <div className="lp-card-body lp-notebook-body">
            <button
              className="lp-signin-btn"
              onClick={() => void handleSignInClick()}
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

          {/* Security note */}
          <div className="lp-security lp-notebook-security">
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
