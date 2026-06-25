import React from "react";
import { Navigate, Outlet } from "react-router-dom";
import { usePermissions } from "@refinedev/core";

export function RequireAdmin(): React.ReactElement {
  const { data: roles, isLoading } = usePermissions<string[]>();

  if (isLoading) return <></>;

  if (!roles?.includes("admin")) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}
