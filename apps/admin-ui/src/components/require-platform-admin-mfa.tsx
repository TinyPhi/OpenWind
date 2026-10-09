import React from "react";
import { Navigate, Outlet } from "react-router-dom";
import { fetchRawWithAuth, API_URL } from "../lib/api.js";

type CheckState = "loading" | "ok" | "mfa-required" | "unauthorized";

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- nested inside RequirePlatformAdmin (role already
 * confirmed), this additionally confirms MFA has been verified this session by calling
 * GET /platform-admin/session -- the same requirePlatformAdmin middleware every other
 * platform-admin route runs behind, so this check can never drift from what the API
 * actually enforces (no client-side MFA-verified flag to keep in sync with the server's
 * own Redis-backed one).
 */
export function RequirePlatformAdminMfa(): React.ReactElement {
  const [state, setState] = React.useState<CheckState>("loading");

  React.useEffect(() => {
    let cancelled = false;
    fetchRawWithAuth(`${API_URL}/platform-admin/session`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          setState("ok");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setState(
          body.error === "MFA_REQUIRED" ? "mfa-required" : "unauthorized",
        );
      })
      .catch(() => {
        if (!cancelled) setState("unauthorized");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") return <></>;
  if (state === "mfa-required") {
    return <Navigate to="/platform-admin/mfa" replace />;
  }
  if (state === "unauthorized") {
    return <Navigate to="/platform-admin/login" replace />;
  }

  return <Outlet />;
}
