import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { userManager } from "../authProvider.js";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { toTypeSlug, type EntityType } from "../entity-type-context.js";
import type { HandoffState } from "./login.js";

// Both ids end up interpolated straight into a fetchWithAuth URL path
// (entityTypeId) or router state (workflowId) -- a bare typeof "string"
// check lets a crafted state (e.g. a path-traversal entityTypeId) reach
// that fetch call before anything rejects it. Requiring UUID shape closes
// that off at the guard itself, not by relying on the try/catch below to
// paper over whatever the malformed value causes downstream.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isHandoffState(state: unknown): state is HandoffState {
  return (
    typeof state === "object" &&
    state !== null &&
    typeof (state as HandoffState).workflowId === "string" &&
    typeof (state as HandoffState).entityTypeId === "string" &&
    UUID_RE.test((state as HandoffState).workflowId) &&
    UUID_RE.test((state as HandoffState).entityTypeId) &&
    // docs/specs/third-party-api-origin-tagging.md R2 — required. A state
    // object missing it (e.g. an in-flight redirect started before this
    // param existed) falls through to the default /dashboard destination
    // below, same graceful-degradation posture as a bad workflowId (R5).
    typeof (state as HandoffState).appClientId === "string"
  );
}

export function AuthCallback(): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    userManager
      .signinCallback()
      .then(async (user) => {
        // Personal dashboard is reachable by every role (docs/specs/personal-dashboard.md
        // R5) — customers used to be sent straight to /records here, bypassing it entirely.
        if (!user) {
          navigate("/login");
          return;
        }

        // Hosted ticket-create handoff (docs/specs/hosted-ticket-create-handoff.md,
        // T2/T3) -- resolved via a direct fetchWithAuth call, NOT
        // EntityTypeProvider's context, which does not wrap this route.
        // Any failure here (bad id, network error) falls through to the
        // default /dashboard destination (spec R5) rather than blocking.
        if (isHandoffState(user.state)) {
          const handoff = user.state;
          try {
            // fetchWithAuth returns `unknown` -- the /entity-types/:id
            // response shape is { data: EntityType }, which the type
            // system has no way to know from the return type alone.
            const entityType = (await fetchWithAuth(
              `${API_URL}/entity-types/${handoff.entityTypeId}`,
            )) as { data: EntityType };
            const slug = toTypeSlug(
              entityType.data.plural || entityType.data.name,
            );
            navigate(`/records/${slug}/new`, {
              state: {
                workflowId: handoff.workflowId,
                entityTypeId: handoff.entityTypeId,
                prefillFields: handoff.prefillFields,
                appClientId: handoff.appClientId,
              },
            });
            return;
          } catch {
            // fall through to the default destination below
          }
        }

        navigate("/dashboard");
      })
      .catch((err: Error) => {
        setError(err.message || String(err));
      });
  }, [navigate]);

  if (error) {
    return (
      <div className="loader-container">
        <div style={{ color: "var(--danger)", marginBottom: "20px" }}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="2"
            stroke="currentColor"
            style={{ width: "48px", height: "48px" }}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
            />
          </svg>
        </div>
        <h2 style={{ marginBottom: "10px" }}>{t("authCallback.errorTitle")}</h2>
        <p className="loader-text">{error}</p>
        <button
          className="login-btn"
          onClick={() => navigate("/login")}
          style={{ marginTop: "24px", width: "auto" }}
        >
          {t("authCallback.backToLogin")}
        </button>
      </div>
    );
  }

  return (
    <div className="loader-container">
      <div className="spinner"></div>
      <p className="loader-text">{t("authCallback.verifying")}</p>
    </div>
  );
}
