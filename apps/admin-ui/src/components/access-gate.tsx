import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { isAccessDeniedReason } from "../lib/session-expiry.js";

type GateState = "checking" | "allowed" | "failed";
type CheckResult = "allowed" | "denied" | "failed";

// One check per page load: navigating between pages doesn't ask again, a reload does.
let check: Promise<CheckResult> | null = null;

function checkAccess(): Promise<CheckResult> {
  check ??= fetchWithAuth(`${API_URL}/auth/access`).then(
    (): CheckResult => "allowed",
    (err: unknown): CheckResult => {
      // A refusal (no tenant, blocked, no role) has already sent the browser to
      // /access-denied (lib/api.ts); keep showing "Checking…" until it gets there.
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? err.code
          : undefined;
      if (typeof code === "string" && isAccessDeniedReason(code)) {
        return "denied";
      }
      // Anything else (network, server) can be retried.
      check = null;
      return "failed";
    },
  );
  return check;
}

export function resetAccessGateForTests(): void {
  check = null;
}

/**
 * docs/specs/tenant-access-gate.md R3: no app page renders until GET /auth/access says this
 * login may use this environment.
 */
export function AccessGate({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<GateState>("checking");

  const run = useCallback((): (() => void) => {
    let cancelled = false;
    setState("checking");
    void checkAccess().then((result) => {
      if (cancelled || result === "denied") return;
      setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => run(), [run]);

  if (state === "allowed") return <>{children}</>;

  return (
    <div
      role="status"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "14px",
        color: "var(--text-secondary)",
        fontSize: "14px",
      }}
    >
      {state === "checking" ? (
        <>
          <div className="spinner" aria-hidden="true" />
          {t("accessDenied.checking")}
        </>
      ) : (
        <>
          {t("accessDenied.checkFailed")}
          <button type="button" className="btn btn-primary" onClick={run}>
            {t("accessDenied.retry")}
          </button>
        </>
      )}
    </div>
  );
}
