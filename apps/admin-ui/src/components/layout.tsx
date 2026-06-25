import React, { useEffect, useRef, useState } from "react";
import { useLogout, useGetIdentity } from "@refinedev/core";
import { Link, useLocation } from "react-router-dom";
import { userManager } from "../authProvider.js";

// ── Admin nav items ──────────────────────────────────────────────────────────

// Nav shown to super-admins only
const SUPER_ADMIN_NAV_EXTRA = [
  {
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
  },
];

const ADMIN_NAV = [
  {
    route: "/",
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
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void userManager.getUser().then((u) => {
      setRoles(
        getRolesFromProfile(u?.profile as Record<string, unknown> | undefined),
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
  //   user   = record assignee — Records + Templates only (portal-like view)
  const isAdmin = roles.includes("admin");
  const isAgent = roles.includes("agent") && !isAdmin;
  const isCustomer =
    (roles.includes("user") || roles.includes("customer")) &&
    !isAdmin &&
    !isAgent;
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
    if (route === "/")
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
        <div className="logo-icon">W</div>
        <div className="logo-text">OpenWind</div>
        {isCustomer && (
          <span
            style={{
              fontSize: "11px",
              padding: "2px 8px",
              borderRadius: "4px",
              background: "hsla(250,84%,60%,.15)",
              color: "var(--accent-primary)",
              fontWeight: 600,
              marginLeft: "4px",
            }}
          >
            Portal
          </span>
        )}
      </div>

      <div
        className="header-user"
        ref={profileRef}
        style={{ position: "relative" }}
      >
        <button
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "5px 12px 5px 5px",
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-color)",
            borderRadius: "20px",
            cursor: "pointer",
            transition: "box-shadow .15s",
            maxWidth: "200px",
          }}
          onClick={() => setProfileOpen((o) => !o)}
          aria-label="Open profile"
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.boxShadow =
              "var(--shadow-sm)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.boxShadow = "none";
          }}
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
              width: "240px",
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
                alignItems: "center",
                gap: "12px",
                padding: "16px",
              }}
            >
              <img
                src={
                  identity?.avatar ??
                  `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&fontSize=38&fontWeight=700&chars=2`
                }
                alt="Avatar"
                style={{
                  width: "42px",
                  height: "42px",
                  borderRadius: "50%",
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {email}
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--accent-primary)",
                    fontWeight: 500,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    marginTop: "2px",
                  }}
                >
                  {roleLabel}
                </div>
              </div>
            </div>
            <div
              style={{
                height: "1px",
                background: "var(--border-color)",
                margin: "0 16px",
              }}
            />
            <button
              onClick={handleLogout}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                width: "100%",
                padding: "12px 16px",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--danger)",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "hsla(350,80%,60%,.1)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "none";
              }}
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
              style={{
                padding: "12px 8px",
                display: "flex",
                flexDirection: "column",
                gap: "2px",
              }}
            >
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

              {/* Templates — users can browse / fork workflows */}
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

              <div className="nav-divider" />
              <Link
                to="/settings"
                className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive("/settings") ? "active" : ""}`}
                title={!sidebarOpen ? "Settings" : undefined}
              >
                {SETTINGS_NAV.icon}
                {(sidebarOpen || mobileNavOpen) && <span>Settings</span>}
              </Link>
            </nav>
          </aside>
          <main className="main-content">{children}</main>
        </div>
      </div>
    );
  }

  // Agent nav = admin nav minus Dashboard, plus no Users
  // Super admin gets all ADMIN_NAV + SUPER_ADMIN_NAV_EXTRA (Users)
  const sidebarNav = isAdmin
    ? [...ADMIN_NAV, ...SUPER_ADMIN_NAV_EXTRA]
    : ADMIN_NAV; // agents see same nav as admin minus dashboard (dashboard requires admin role — handled by page itself)

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
            {sidebarNav.map((item) => (
              <Link
                key={item.route}
                to={item.route}
                className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive(item.route) ? "active" : ""}`}
                title={!sidebarOpen ? item.label : undefined}
              >
                {item.icon}
                {(sidebarOpen || mobileNavOpen) && <span>{item.label}</span>}
              </Link>
            ))}

            <div className="nav-divider" />

            <Link
              to={SETTINGS_NAV.route}
              className={`menu-item ${!sidebarOpen && !mobileNavOpen ? "menu-item-icon-only" : ""} ${isActive(SETTINGS_NAV.route) ? "active" : ""}`}
              title={!sidebarOpen ? SETTINGS_NAV.label : undefined}
            >
              {SETTINGS_NAV.icon}
              {sidebarOpen && <span>{SETTINGS_NAV.label}</span>}
            </Link>
          </nav>
        </aside>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
