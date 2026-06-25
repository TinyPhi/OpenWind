import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { userManager } from "../authProvider.js";

export function AuthCallback(): React.ReactElement {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    userManager
      .signinCallback()
      .then(async () => {
        const user = await userManager.getUser();
        const profile = (user?.profile ?? {}) as Record<string, unknown>;
        const rolesMap = (profile["urn:zitadel:iam:org:project:roles"] ??
          {}) as Record<string, unknown>;
        const roles = Object.keys(rolesMap);
        const isCustomer =
          (roles.includes("user") || roles.includes("customer")) &&
          !roles.includes("admin") &&
          !roles.includes("agent");
        navigate(isCustomer ? "/records" : "/");
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
        <h2 style={{ marginBottom: "10px" }}>Authentication Error</h2>
        <p className="loader-text">{error}</p>
        <button
          className="login-btn"
          onClick={() => navigate("/login")}
          style={{ marginTop: "24px", width: "auto" }}
        >
          Back to Login
        </button>
      </div>
    );
  }

  return (
    <div className="loader-container">
      <div className="spinner"></div>
      <p className="loader-text">
        Verifying credentials and synchronizing session...
      </p>
    </div>
  );
}
