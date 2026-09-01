import React, { useEffect, useRef, useState } from "react";
import { useLogout, useGetIdentity } from "@refinedev/core";
import { Link, useLocation } from "react-router-dom";
import { TOKENS, useHoverStyle } from "@platform/ui";
import { userManager } from "../authProvider.js";
import { NotificationBell } from "./notification-bell.js";

// ── Admin nav items ──────────────────────────────────────────────────────────

// Nav shown to super-admins only
const USERS_NAV = {
  route: "/users",
  label: "Users",
  icon: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
      />
    </svg>
  ),
};

// Backend requires the "admin" role (requireRole("admin") in
// apps/api/src/routes/admin/system-logs.ts) — agents don't see this entry.
const SYSTEM_LOGS_NAV = {
  route: "/admin/system-logs",
  label: "System Logs",
  icon: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  ),
};

// Backend requires the "admin" role (requireRole("admin") in
// apps/api/src/routes/admin/third-party-access-logs.ts) -- ADR-012 Phase F.
// PR #489 review, S-03 -- a magnifying glass conventionally means "search",
// not "access logs"; swapped for a clipboard-list icon.
const THIRD_PARTY_ACCESS_LOGS_NAV = {
  route: "/admin/third-party-access-logs",
  label: "API Access Logs",
  icon: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
      />
    </svg>
  ),
};

// Backend requires the "admin" role (requireRole("admin") in
// apps/api/src/routes/api-keys/create.ts and the rest of that router) —
// moved here from a tab inside Settings so it's discoverable alongside its
// own access-logs view, not buried in a generic settings screen.
const API_KEYS_NAV = {
  route: "/admin/api-keys",
  label: "API Keys",
  icon: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
      />
    </svg>
  ),
};

const SUPER_ADMIN_NAV_EXTRA = [
  USERS_NAV,
  SYSTEM_LOGS_NAV,
  API_KEYS_NAV,
  THIRD_PARTY_ACCESS_LOGS_NAV,
];

const ADMIN_NAV = [
  {
    // Personal "my view" dashboard — docs/specs/personal-dashboard.md.
    // Reachable by every role (admin/agent nav here, customer nav below).
    route: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth="2"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
        />
      </svg>
    ),
  },
  {
    // Tenant-wide KPI overview — admin/agent only (see the redirect-away
    // check inside pages/dashboard.tsx, the Analytics component; this nav
    // entry was formerly labeled "Dashboard" at route "/" before the
    // personal dashboard above took over that name/landing slot).
    route: "/analytics",
    label: "Analytics",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth="2"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
        />
      </svg>
    ),
  },
  {
    route: "/modules",
    label: "Templates",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth="2"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z"
        />
      </svg>
    ),
  },
  {
    route: "/workflows",
    label: "Workflows",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth="2"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69zM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z"
        />
      </svg>
    ),
  },
  {
    route: "/automations",
    label: "Automations",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth="2"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
        />
      </svg>
    ),
  },
  {
    route: "/records",
    label: "Records",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth="2"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
        />
      </svg>
    ),
  },
];

const SETTINGS_NAV = {
  route: "/settings",
  label: "Settings",
  icon: (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.43l-1.003.828c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.43l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.991l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.645-.869l.214-1.28z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
      />
    </svg>
  ),
};

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getRolesFromProfile(
  profile: Record<string, unknown> | undefined,
): string[] {
  if (!profile) return [];
  const rolesMap = (profile["urn:zitadel:iam:org:project:roles"] ??
    {}) as Record<string, unknown>;
  return Object.keys(rolesMap);
}

// â”€â”€ Layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function Layout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const { mutate: refineLogout } = useLogout();
  const { data: identity } = useGetIdentity<{
    id: string;
    name: string;
    email: string;
    avatar: string;
  }>();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [roles, setRoles] = useState<string[]>([]);
  const [username, setUsername] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const profileButtonHover = useHoverStyle({
    base: { background: "transparent" },
    hover: { background: TOKENS.bgTertiary },
  });
  const signOutHover = useHoverStyle({
    base: { background: "none" },
    hover: {
      background: `color-mix(in srgb, ${TOKENS.danger} 10%, transparent)`,
    },
  });

  useEffect(() => {
    void userManager.getUser().then((u) => {
      const profile = u?.profile as Record<string, unknown> | undefined;
      setRoles(getRolesFromProfile(profile));
      setUsername(
        (profile?.["preferred_username"] as string | undefined) ?? "",
      );
    });
  }, []);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function close(e: MouseEvent): void {
      if (profileRef.current && !profileRef.current.contains(e.target as Node))
        setProfileOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // RBAC tiers:
  //   admin  = super admin — full access including Users page
  //   agent  = workflow admin — Workflows + Templates + Records, no Users/Dashboard
  //   user   = record assignee — Records only, no Templates (portal-like view)
  const isAdmin = roles.includes("admin");
  const isAgent = roles.includes("agent") && !isAdmin;
  const isCustomer =
    (roles.includes("user") || roles.includes("customer")) &&
    !isAdmin &&
    !isAgent;
  const isPlainUser = isCustomer && roles.includes("user");
  const roleLabel = isAdmin
    ? "Administrator"
    : isAgent
      ? "Agent"
      : roles.includes("user")
        ? "User"
        : "Customer";

  const name = identity?.name ?? (isCustomer ? "User" : "Admin");
  const email = identity?.email ?? "";

  function handleLogout(): void {
    if (isCustomer) {
      void userManager.removeUser().then(() => {
        window.location.href = "/login";
      });
    } else {
      refineLogout();
    }
  }

  function isActive(route: string): boolean {
    // "/" itself always redirects to "/dashboard" (see App.tsx's index
    // route) — treat them as the same nav item so landing on "/" briefly
    // during that redirect still highlights Dashboard, not nothing.
    if (route === "/dashboard")
      return location.pathname === "/" || location.pathname === "/dashboard";
    return (
      location.pathname === route || location.pathname.startsWith(route + "/")
    );
  }

  // â”€â”€ Shared topnav â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const topnav = (
    <header className="main-header">
      <div className="header-title-section">
        <button
          className="admin-hamburger"
          onClick={() => {
            // On mobile (â‰¤640px) only drive the overlay drawer
            if (window.innerWidth <= 640) {
              setMobileNavOpen((o) => !o);
            } else {
              setSidebarOpen((o) => !o);
            }
          }}
          aria-label="Toggle sidebar"
        >
          <span />
          <span />
          <span />
        </button>
        <img src="/ow-logo.png" alt="OpenWind" className="logo-icon" />
        <div className="logo-text">OpenWind</div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <NotificationBell />
        <div
          className="header-user"
          ref={profileRef}
          style={{ position: "relative" }}
        >
          <button
            className="header-profile-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "7px",
              padding: "3px 10px 3px 3px",
              border: `1px solid ${TOKENS.borderColor}`,
              borderRadius: "18px",
              cursor: "pointer",
              transition: "background .15s, border-color .15s",
              maxWidth: "180px",
              ...profileButtonHover.style,
            }}
            onClick={() => setProfileOpen((o) => !o)}
            aria-label="Open profile"
            onMouseEnter={profileButtonHover.onMouseEnter}
            onMouseLeave={profileButtonHover.onMouseLeave}
          >
            <img
              src={
                identity?.avatar ??
                `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&fontSize=38&fontWeight=700&chars=2`
              }
              alt="Avatar"
              className="header-avatar"
              style={{ flexShrink: 0 }}
            />
            <span
              className="header-username"
              style={{
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
          </button>

          {profileOpen && (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 10px)",
                right: 0,
                width: "260px",
                background: "var(--bg-secondary)",
                border: "1px solid var(--border-color)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-lg)",
                zIndex: 200,
                overflow: "hidden",
                animation: "popup-in .12s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  textAlign: "center",
                  gap: "10px",
                  padding: "24px 16px 16px",
                }}
              >
                <img
                  src={
                    identity?.avatar ??
                    `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&fontSize=38&fontWeight=700&chars=2`
                  }
                  alt="Avatar"
                  style={{
                    width: "64px",
                    height: "64px",
                    borderRadius: "50%",
                    flexShrink: 0,
                    border: "2px solid var(--border-color)",
                  }}
                />
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}
                </div>
                <span className="badge badge-primary">{roleLabel}</span>
              </div>
              <div
                style={{
                  height: "1px",
                  background: "var(--border-color)",
                }}
              />
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  padding: "14px 16px",
                }}
              >
                {email && (
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "10.5px",
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        marginBottom: "2px",
                      }}
                    >
                      Email
                    </div>
                    <div
                      style={{
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {email}
                    </div>
                  </div>
                )}
                {username && username !== email && (
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "10.5px",
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        marginBottom: "2px",
                      }}
                    >
                      Username
                    </div>
                    <div
                      style={{
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {username}
                    </div>
                  </div>
                )}
              </div>
              <div
                style={{
                  height: "1px",
                  background: "var(--border-color)",
                }}
              />
              <button
                onClick={handleLogout}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "10px",
                  width: "100%",
                  padding: "13px 16px",
                  fontSize: "13px",
                  fontWeight: 500,
                  color: TOKENS.danger,
                  border: "none",
                  cursor: "pointer",
                  ...signOutHover.style,
                }}
                onMouseEnter={signOutHover.onMouseEnter}
                onMouseLeave={signOutHover.onMouseLeave}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                  width="16"
                  height="16"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"
                  />
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );

  // ── Customer / user layout ──────────────────────────────────────────────
  if (isCustomer) {
    return (
      <div className="app-container">
        {topnav}
        <div className="app-body">
          {mobileNavOpen && (
            <div
              className="mobile-nav-backdrop"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
          )}
          <aside
            className={`sidebar ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"} ${mobileNavOpen ? "mobile-nav-open" : ""}`}
          >
            <nav
              className="sidebar-menu"
              style={{
                padding: "12px 8px",
                gap: "2px",
              }}
            >
              {/* Personal dashboard — docs/specs/personal-dashboard.md;
                  reachable by every role, customers included (R5). */}
              <Link
                to="/dashboard"
                className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive("/dashboard") ? "active" : ""}`}
                title={!sidebarOpen ? "Dashboard" : undefined}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
                  />
                </svg>
                {(sidebarOpen || mobileNavOpen) && <span>Dashboard</span>}
              </Link>

              {/* Records — shows cards where user has assigned tickets */}
              <Link
                to="/records"
                className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive("/records") ? "active" : ""}`}
                title={!sidebarOpen ? "Records" : undefined}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776"
                  />
                </svg>
                {(sidebarOpen || mobileNavOpen) && <span>Records</span>}
              </Link>

              {/* Templates — customers can browse / fork workflows. Hidden
                  for the plain "user" role (record assignees only). */}
              {!isPlainUser && (
                <Link
                  to="/modules"
                  className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive("/modules") ? "active" : ""}`}
                  title={!sidebarOpen ? "Templates" : undefined}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="2"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z"
                    />
                  </svg>
                  {(sidebarOpen || mobileNavOpen) && <span>Templates</span>}
                </Link>
              )}

              {/* Workflows — users can create & manage their own workflows.
                  Hidden for the plain "user" role (record assignees only) —
                  they work from Records, not the workflow browser. */}
              {!isPlainUser && (
                <Link
                  to="/workflows"
                  className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive("/workflows") ? "active" : ""}`}
                  title={!sidebarOpen ? "Workflows" : undefined}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth="2"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69zM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z"
                    />
                  </svg>
                  {(sidebarOpen || mobileNavOpen) && <span>Workflows</span>}
                </Link>
              )}

              {/* Users — org member list (read-only for customers, no admin actions) */}
              <Link
                to={USERS_NAV.route}
                className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive(USERS_NAV.route) ? "active" : ""}`}
                title={!sidebarOpen ? USERS_NAV.label : undefined}
              >
                {USERS_NAV.icon}
                {(sidebarOpen || mobileNavOpen) && (
                  <span>{USERS_NAV.label}</span>
                )}
              </Link>
            </nav>

            <div className="sidebar-footer">
              <div className="nav-divider" />
              <Link
                to="/settings"
                className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive("/settings") ? "active" : ""}`}
                title={!sidebarOpen ? "Settings" : undefined}
              >
                {SETTINGS_NAV.icon}
                {(sidebarOpen || mobileNavOpen) && <span>Settings</span>}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className={`menu-item sidebar-logout ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""}`}
                title={!sidebarOpen ? "Sign out" : undefined}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"
                  />
                </svg>
                {(sidebarOpen || mobileNavOpen) && <span>Sign out</span>}
              </button>
            </div>
          </aside>
          <main className="main-content">{children}</main>
        </div>
      </div>
    );
  }

  // Agent nav = admin nav minus Users. Both admin and agent see Dashboard
  // (personal, all roles) and Analytics (admin/agent only — gated inside the
  // Analytics page itself, not here) via the shared ADMIN_NAV array.
  // Super admin ALSO gets SUPER_ADMIN_NAV_EXTRA, rendered as a visually
  // separate labeled section below (not just appended to the same flat
  // list) so admin-only items are easy to tell apart from the rest of the
  // workspace at a glance.
  const workspaceNav = ADMIN_NAV;
  const adminOnlyNav = isAdmin ? SUPER_ADMIN_NAV_EXTRA : [];

  function renderNavItem(item: (typeof ADMIN_NAV)[number]): React.ReactElement {
    return (
      <Link
        key={item.route}
        to={item.route}
        className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive(item.route) ? "active" : ""}`}
        title={!sidebarOpen ? item.label : undefined}
      >
        {item.icon}
        {(sidebarOpen || mobileNavOpen) && <span>{item.label}</span>}
      </Link>
    );
  }

  // ── Admin / Agent layout ────────────────────────────────────────────────
  return (
    <div className="app-container">
      {topnav}
      <div className="app-body">
        {mobileNavOpen && (
          <div
            className="mobile-nav-backdrop"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
        )}
        <aside
          className={`sidebar ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"} ${mobileNavOpen ? "mobile-nav-open" : ""}`}
        >
          <nav className="sidebar-menu">
            {workspaceNav.map(renderNavItem)}

            {adminOnlyNav.length > 0 && (
              <>
                <div className="nav-divider" />
                {(sidebarOpen || mobileNavOpen) && (
                  <div className="sidebar-section-label">Admin</div>
                )}
                {adminOnlyNav.map(renderNavItem)}
              </>
            )}
          </nav>

          <div className="sidebar-footer">
            <div className="nav-divider" />

            <Link
              to={SETTINGS_NAV.route}
              className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive(SETTINGS_NAV.route) ? "active" : ""}`}
              title={!sidebarOpen ? SETTINGS_NAV.label : undefined}
            >
              {SETTINGS_NAV.icon}
              {sidebarOpen && <span>{SETTINGS_NAV.label}</span>}
            </Link>

            <button
              type="button"
              onClick={handleLogout}
              className={`menu-item sidebar-logout ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""}`}
              title={!sidebarOpen ? "Sign out" : undefined}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="2"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"
                />
              </svg>
              {sidebarOpen && <span>Sign out</span>}
            </button>
          </div>
        </aside>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
