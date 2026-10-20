import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { userManager } from "../authProvider.js";
import { isAccessDeniedReason } from "../lib/session-expiry.js";
import { CONTACT_EMAIL } from "./login-contact.js";

export const SIGN_OUT_AFTER_SECONDS = 5;

/**
 * Ends the session at Zitadel too, so the next login can pick another account instead of
 * Zitadel silently signing the same one back in. Falls back to a local sign-out when Zitadel
 * can't be reached, so nobody is left stuck here.
 */
async function signOutEverywhere(): Promise<void> {
  const user = await userManager.getUser().catch(() => null);
  try {
    await userManager.clearStaleState();
    await userManager.signoutRedirect(
      user?.id_token ? { id_token_hint: user.id_token } : undefined,
    );
  } catch {
    await userManager.removeUser().catch(() => undefined);
    window.location.replace("/login");
  }
}

function contactHref(subject: string): string {
  const params = new URLSearchParams({ subject });
  return `mailto:${CONTACT_EMAIL}?${params.toString()}`;
}

/**
 * docs/specs/tenant-access-gate.md R4: why this login may not use OpenWind here, then a
 * 5-second countdown to a full sign-out and the login page.
 */
export function AccessDenied(): React.ReactElement {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const raw = params.get("reason");
  const reason = isAccessDeniedReason(raw) ? raw : "TENANT_NOT_FOUND";
  const [secondsLeft, setSecondsLeft] = useState(SIGN_OUT_AFTER_SECONDS);
  const [signingOut, setSigningOut] = useState(false);
  const started = useRef(false);

  const signOut = useCallback((): void => {
    if (started.current) return;
    started.current = true;
    setSigningOut(true);
    void signOutEverywhere();
  }, []);

  useEffect(() => {
    if (signingOut) return;
    if (secondsLeft <= 0) {
      signOut();
      return;
    }
    const timer = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft, signingOut, signOut]);

  const progress = secondsLeft / SIGN_OUT_AFTER_SECONDS;

  return (
    <main className="acd-page">
      <section
        className="acd-card"
        role="alertdialog"
        aria-labelledby="acd-title"
        aria-describedby="acd-reason"
      >
        <div className="acd-visual" aria-hidden="true">
          <svg viewBox="0 0 120 120" className="acd-ring">
            <circle cx="60" cy="60" r="52" className="acd-ring-track" />
            <circle
              cx="60"
              cy="60"
              r="52"
              className="acd-ring-fill"
              style={{ strokeDashoffset: `${(1 - progress) * 326.7}` }}
            />
          </svg>
          <svg viewBox="0 0 48 48" className="acd-lock">
            <path
              d="M16 21v-5a8 8 0 0 1 16 0v5"
              className="acd-shackle"
              fill="none"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <rect x="11" y="21" width="26" height="20" rx="4" />
            <circle cx="24" cy="30" r="2.6" className="acd-keyhole" />
            <rect
              x="22.8"
              y="31"
              width="2.4"
              height="5"
              rx="1.2"
              className="acd-keyhole"
            />
          </svg>
        </div>

        <h1 id="acd-title" className="acd-title">
          {t("accessDenied.title")}
        </h1>
        <p id="acd-reason" className="acd-reason">
          {t(`accessDenied.reasons.${reason}`)}
        </p>

        <p className="acd-countdown" aria-live="polite">
          {signingOut
            ? t("accessDenied.signingOut")
            : t("accessDenied.countdown", { count: secondsLeft })}
        </p>

        <button
          type="button"
          className="acd-button"
          onClick={signOut}
          disabled={signingOut}
        >
          {t("accessDenied.signOutNow")}
        </button>

        <a
          className="acd-contact"
          href={contactHref(t("accessDenied.contactSubject"))}
        >
          {t("accessDenied.contact")}
        </a>
      </section>

      <style>{`
        .acd-page {
          min-height: 100vh; display: flex; align-items: center; justify-content: center;
          padding: 24px; background: var(--bg-secondary, #f5f6f8);
        }
        .acd-card {
          width: 100%; max-width: 420px; text-align: center; padding: 36px 32px 28px;
          background: var(--bg-primary, #fff); border: 1px solid var(--border-primary, #e3e6ea);
          border-radius: 16px; box-shadow: 0 12px 40px rgba(16, 24, 40, 0.08);
          animation: acd-rise 360ms ease-out both;
        }
        .acd-visual { position: relative; width: 112px; height: 112px; margin: 0 auto 20px; }
        .acd-ring { position: absolute; inset: 0; transform: rotate(-90deg); }
        .acd-ring-track { fill: none; stroke: var(--border-primary, #e3e6ea); stroke-width: 6; }
        .acd-ring-fill {
          fill: none; stroke: var(--danger, #d64545); stroke-width: 6; stroke-linecap: round;
          stroke-dasharray: 326.7; transition: stroke-dashoffset 1s linear;
        }
        .acd-lock {
          position: absolute; inset: 30px; fill: var(--danger, #d64545);
          animation: acd-pulse 1.6s ease-in-out infinite;
        }
        .acd-shackle { stroke: var(--danger, #d64545); }
        .acd-keyhole { fill: var(--bg-primary, #fff); }
        .acd-title { margin: 0 0 8px; font-size: 20px; font-weight: 700; color: var(--text-primary, #101828); }
        .acd-reason { margin: 0 0 18px; font-size: 14.5px; line-height: 1.5; color: var(--text-secondary, #475467); }
        .acd-countdown { margin: 0 0 16px; font-size: 13px; color: var(--text-tertiary, #667085); }
        .acd-button {
          width: 100%; padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer;
          border: none; border-radius: 8px; color: #fff; background: var(--accent-primary, #2f6fed);
        }
        .acd-button:disabled { opacity: 0.6; cursor: default; }
        .acd-contact { display: inline-block; margin-top: 14px; font-size: 12.5px; color: var(--text-tertiary, #667085); }
        @keyframes acd-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.07); } }
        @keyframes acd-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) {
          .acd-card, .acd-lock { animation: none; }
          .acd-ring-fill { transition: none; }
        }
      `}</style>
    </main>
  );
}
