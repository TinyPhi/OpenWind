import React from "react";
import { Navigate, Outlet } from "react-router-dom";
import { usePermissions } from "@refinedev/core";

/**
 * T17 (docs/specs/multi-org-sandbox.md) -- gates the whole /platform-admin/* route tree.
 * Reuses the existing OIDC identity/authProvider entirely: `platform_admin` is just
 * another key in the same Zitadel roles claim `usePermissions()` already reads for
 * `RequireAdmin` (see packages/auth/src/jwks.ts's extractPlatformAdminContext, which does
 * the identical `Object.keys(rolesMap)` check server-side) -- no separate login mechanism.
 */
export function RequirePlatformAdmin(): React.ReactElement {
  const { data: roles, isLoading } = usePermissions<string[]>();

  if (isLoading) return <></>;

  if (!roles?.includes("platform_admin")) {
    return <Navigate to="/platform-admin/login" replace />;
  }

  return <Outlet />;
}
