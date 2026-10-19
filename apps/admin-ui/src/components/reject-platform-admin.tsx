import React from "react";
import { Navigate } from "react-router-dom";
import { usePermissions } from "@refinedev/core";

/**
 * Inverse of RequirePlatformAdmin, wrapped around the whole tenant shell
 * (docs/specs/multi-org-sandbox.md R1: a platform admin "never [sees] the normal
 * tenant-scoped admin-ui shell"). Renders nothing until roles resolve, so
 * EntityTypeProvider/Layout -- which fire tenant requests on mount -- never mount for a
 * platform_admin. The API rejects those requests anyway (requireAuth's
 * PLATFORM_ADMIN_TENANT_ACCESS_DENIED); this keeps the UI from rendering a tenant shell.
 *
 * Intentionally fail-open on permissions error (isLoading: false, roles: undefined):
 * if fetching permissions fails, the tenant shell is rendered rather than a blank screen.
 * The backend `requireAuth` provides the authoritative security guard by answering
 * 403 PLATFORM_ADMIN_TENANT_ACCESS_DENIED to platform-admin tokens.
 */
export function RejectPlatformAdmin({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { data: roles, isLoading } = usePermissions<string[]>();

  if (isLoading) return <></>;

  if (Array.isArray(roles) && roles.includes("platform_admin")) {
    return <Navigate to="/platform-admin/dashboard" replace />;
  }

  return <>{children}</>;
}
