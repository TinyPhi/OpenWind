import React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";

/**
 * T3/T17 (docs/specs/multi-org-sandbox.md). Requests a code on mount (best-effort -- a
 * failed send is shown inline, not fatal, since the admin can still retry or the code may
 * already be in their inbox from a previous attempt), then verifies the 6-digit code the
 * admin enters. On success, the server-side Redis MFA-verified flag RequirePlatformAdminMfa
 * checks is now set, so navigating to /dashboard passes that guard.
 */
export function PlatformAdminMfa(): React.ReactElement {
  const navigate = useNavigate();
  const [code, setCode] = React.useState("");
  const [requestError, setRequestError] = React.useState<string | null>(null);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const requested = React.useRef(false);

  React.useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    fetchWithAuth(`${API_URL}/platform-admin/mfa/request`, {
      method: "POST",
    }).catch((err: unknown) => {
      setRequestError(
        err instanceof Error ? err.message : "Could not send code",
      );
    });
  }, []);

  async function handleVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setVerifying(true);
    setVerifyError(null);
    try {
      await fetchWithAuth(`${API_URL}/platform-admin/mfa/verify`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      navigate("/platform-admin/dashboard", { replace: true });
    } catch (err) {
      setVerifyError(
        err instanceof Error ? err.message : "Verification failed",
      );
      setVerifying(false);
    }
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={titleStyle}>Verify it's you</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: 20 }}>
          Enter the 6-digit code sent to your email.
        </p>
        {requestError && (
          <p
            role="alert"
            style={{ color: "var(--danger, #dc2626)", marginBottom: 12 }}
          >
            {requestError}
          </p>
        )}
        <form onSubmit={(e) => void handleVerify(e)}>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            aria-label="Verification code"
            style={inputStyle}
            autoFocus
          />
          <Button
            type="submit"
            disabled={verifying || code.length !== 6}
            style={{ marginTop: 16, width: "100%" }}
          >
            {verifying ? "Verifying…" : "Verify"}
          </Button>
        </form>
        {verifyError && (
          <p
            role="alert"
            style={{ marginTop: 12, color: "var(--danger, #dc2626)" }}
          >
            {verifyError}
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

const inputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 24,
  letterSpacing: 8,
  textAlign: "center",
  padding: "10px 0",
  borderRadius: 8,
  border: "1px solid var(--border-color, #e5e7eb)",
};
