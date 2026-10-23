import React from "react";
import { useNavigate } from "react-router-dom";
import { usePermissions } from "@refinedev/core";
import { Button } from "@platform/ui";
import { userManager } from "../../authProvider.js";

/**
 * T17 (docs/specs/multi-org-sandbox.md). Deliberately its own page, not a reuse of the
 * tenant /login screen -- platform_admin is a distinct operator identity (ADR-022, R1),
 * and conflating the two screens risks a tenant user ending up here by habit. The sign-in
 * action itself is the same Zitadel OIDC redirect the tenant login uses; only the
 * post-login destination differs (see pages/callback.tsx's role check).
 */
export function PlatformAdminLogin(): React.ReactElement {
  const navigate = useNavigate();
  const { data: roles, isLoading } = usePermissions<string[]>({});
  const [loading, setLoading] = React.useState(false);
  const [signInFailed, setSignInFailed] = React.useState(false);

  // getPermissions() returns [] when there is no stored session, so an empty role list
  // means "signed out" here -- otherwise a signed-out visitor got "Not authorized" with no
  // way to sign in.
  const isAuthenticated = !isLoading && (roles?.length ?? 0) > 0;
  const isPlatformAdmin = !!roles?.includes("platform_admin");

  React.useEffect(() => {
    if (isAuthenticated && isPlatformAdmin) {
      void navigate("/platform-admin/dashboard", { replace: true });
    }
  }, [isAuthenticated, isPlatformAdmin, navigate]);

  async function handleSignIn(switchAccount = false): Promise<void> {
    setLoading(true);
    setSignInFailed(false);
    try {
      // Drop the stored (non-platform-admin) session first, or the page would read it back
      // and show "Not authorized" again after the redirect returns.
      if (switchAccount) await userManager.removeUser();
      await userManager.signinRedirect({ prompt: "login" });
    } catch (err) {
      console.error("Platform-admin sign-in failed before redirect:", err);
      setSignInFailed(true);
      setLoading(false);
    }
  }

  if (isLoading || (isAuthenticated && isPlatformAdmin)) return <></>;

  if (isAuthenticated && !isPlatformAdmin) {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          <h1 style={titleStyle}>Not authorized</h1>
          <p style={{ color: "var(--text-muted)" }}>
            Your account does not have platform-admin access.
          </p>
          <Button
            onClick={() => void handleSignIn(true)}
            disabled={loading}
            style={{ marginTop: 20 }}
          >
            {loading ? "Redirecting…" : "Sign in with a different account"}
          </Button>
          {signInFailed && (
            <p
              role="alert"
              style={{ marginTop: 12, color: "var(--danger, #dc2626)" }}
            >
              Sign-in failed. Please try again.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>Platform Admin</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: 20 }}>
          Sign in with your platform-admin account.
        </p>
        <Button onClick={() => void handleSignIn()} disabled={loading}>
          {loading ? "Redirecting…" : "Sign in"}
        </Button>
        {signInFailed && (
          <p
            role="alert"
            style={{ marginTop: 12, color: "var(--danger, #dc2626)" }}
          >
            Sign-in failed. Please try again.
          </p>
        )}
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cardStyle: React.CSSProperties = {
  width: 360,
  padding: 32,
  borderRadius: 12,
  border: "1px solid var(--border-color, #e5e7eb)",
  textAlign: "center",
};

const titleStyle: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 20,
};
