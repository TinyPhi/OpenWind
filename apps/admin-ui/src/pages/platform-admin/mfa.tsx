import React from "react";
import { useNavigate } from "react-router-dom";
import { OtpVerification } from "./otp-verification.js";
import { signOutPlatformAdmin } from "./sign-out.js";

/**
 * T3/T17 (docs/specs/multi-org-sandbox.md). Every platform-admin sign-in lands here: the code
 * is sent on arrival, and a verified code starts this sign-in's MFA session, which
 * RequirePlatformAdminMfa's /platform-admin/session check then accepts.
 */
export function PlatformAdminMfa(): React.ReactElement {
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = React.useState(false);

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      const redirectTo = await signOutPlatformAdmin();
      if (redirectTo) window.location.href = redirectTo;
    } catch {
      setSigningOut(false);
    }
  }

  return (
    <div className="pa-auth-page">
      <div className="pa-auth-card">
        <div className="pa-auth-icon" aria-hidden="true">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </div>
        <h1 className="pa-auth-title">Verify it's you</h1>
        <p className="pa-auth-subtitle">
          Platform admin sign-in needs a one-time code every time you log in.
        </p>
        <OtpVerification
          onVerified={() =>
            void navigate("/platform-admin/dashboard", { replace: true })
          }
        />
        <div className="pa-auth-footer">
          Not you, or no access to this inbox?{" "}
          <button
            type="button"
            className="pa-link-btn"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );
}
