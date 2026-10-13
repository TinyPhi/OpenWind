import React, { Suspense } from "react";
import { Refine, Authenticated } from "@refinedev/core";
import routerProvider from "@refinedev/react-router-v6";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  Navigate,
  useLocation,
} from "react-router-dom";
import { authProvider } from "./authProvider.js";
import { dataProvider } from "./dataProvider.js";
import { EntityTypeProvider } from "./entity-type-context.js";
import { Layout } from "./components/layout.js";
import { RouteErrorBoundary } from "./components/route-error-boundary.js";
import { RequireAdmin } from "./components/require-admin.js";
import { RequirePlatformAdmin } from "./components/require-platform-admin.js";
import { RequirePlatformAdminMfa } from "./components/require-platform-admin-mfa.js";
import {
  Login,
  AuthCallback,
  PlatformAdminLogin,
  PlatformAdminMfa,
  PlatformAdminDashboard,
  Dashboard,
  Analytics,
  ReportingPage,
  Modules,
  Plugins,
  EntityTypeDetail,
  EntityInstanceCreate,
  Workflows,
  WorkflowDetail,
  CreateWorkflow,
  AdminRecords,
  WorkflowRecords,
  Settings,
  UsersPage,
  OrgDirectoryPage,
  CustomerRecordCreate,
  CustomerRecordDetail,
  Automations,
  AutomationWizard,
  SystemLogsPage,
  ThirdPartyAccessLogsPage,
  ApiKeysPage,
  ApiKeyApplicationDetail,
  ScheduleRulesPage,
  ScheduleRuleDetailPage,
  TeamsPage,
  ServicesPage,
  RosterPage,
  NotificationPoliciesPage,
  OnCallAdminPage,
} from "./lazy-routes.js";
import { GlobalErrorBanner } from "./components/global-error-banner.js";
import { GlobalAlertDialog } from "./components/global-alert-dialog.js";
import { useIdleLogout } from "./hooks/use-idle-logout.js";
import "./index.css";

function AuthenticatedShell({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  useIdleLogout();
  return <>{children}</>;
}

// Suspense + error boundary live inside the Layout so a lazy route loading (or
// failing to load) never unmounts the sidebar/header.
function ShellOutlet(): React.ReactElement {
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary resetKey={pathname}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Outlet />
      </Suspense>
    </RouteErrorBoundary>
  );
}

function RouteLoadingFallback(): React.ReactElement {
  return (
    <div
      style={{
        padding: "32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "200px",
        color: "var(--text-muted)",
        fontSize: "14px",
      }}
    >
      Loading…
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <GlobalErrorBanner />
      <GlobalAlertDialog />
      <Refine
        authProvider={authProvider}
        dataProvider={dataProvider}
        routerProvider={routerProvider}
        options={{
          reactQuery: {
            // Prevents Authenticated from unmounting children on background auth
            // re-checks triggered by window focus. Token renewal is handled by
            // automaticSilentRenew in oidc-client-ts — background checks are redundant.
            clientConfig: {
              defaultOptions: { queries: { refetchOnWindowFocus: false } },
            },
          },
        }}
        resources={[
          {
            name: "dashboard",
            list: "/dashboard",
            meta: { label: "Dashboard" },
          },
          {
            name: "analytics",
            list: "/analytics",
            meta: { label: "Analytics" },
          },
          { name: "modules", list: "/modules", meta: { label: "Templates" } },
          { name: "plugins", list: "/plugins", meta: { label: "Plugins" } },
          {
            name: "records",
            list: "/records",
            meta: { label: "Records" },
          },
          {
            name: "workflows",
            list: "/workflows",
            show: "/workflows/:id",
            meta: { label: "Workflows" },
          },
          {
            name: "org-directory",
            list: "/org-directory",
            meta: { label: "Org Chart" },
          },
        ]}
      >
        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
            {/* Auth routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />

            {/* Platform Admin (docs/specs/multi-org-sandbox.md T17) — its own route
              tree, entirely outside <Authenticated>/Layout/EntityTypeProvider: a
              platform admin never resolves a tenant and must never see the tenant
              sidebar/header. RequirePlatformAdmin handles both "not logged in" and
              "logged in without the role" by redirecting to its own login page. */}
            <Route
              path="/platform-admin/login"
              element={<PlatformAdminLogin />}
            />
            <Route element={<RequirePlatformAdmin />}>
              <Route
                path="/platform-admin/mfa"
                element={<PlatformAdminMfa />}
              />
              <Route element={<RequirePlatformAdminMfa />}>
                <Route
                  path="/platform-admin/dashboard"
                  element={<PlatformAdminDashboard />}
                />
              </Route>
            </Route>

            {/* Protected routes */}
            <Route
              element={
                <Authenticated
                  key="protected"
                  fallback={<Navigate to="/login" />}
                >
                  <AuthenticatedShell>
                    <EntityTypeProvider>
                      <Layout>
                        <ShellOutlet />
                      </Layout>
                    </EntityTypeProvider>
                  </AuthenticatedShell>
                </Authenticated>
              }
            >
              {/* All authenticated users */}
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/reporting" element={<ReportingPage />} />
              <Route path="/records" element={<AdminRecords />} />
              <Route
                path="/workflows/:workflowSlug/records"
                element={<WorkflowRecords />}
              />

              {/* Automation rules */}
              <Route path="/automations" element={<Automations />} />
              <Route path="/automations/new" element={<AutomationWizard />} />
              <Route
                path="/automations/:id/edit"
                element={<AutomationWizard />}
              />

              {/* Customer routes */}
              <Route
                path="/records/:typeSlug/new"
                element={<CustomerRecordCreate />}
              />
              <Route
                path="/records/:typeSlug/:id"
                element={<CustomerRecordDetail />}
              />

              <Route path="/settings" element={<Settings />} />

              <Route path="/modules" element={<Modules />} />
              <Route path="/plugins" element={<Plugins />} />

              {/* Workflow detail — access checked inside component (admin or workflow assignee) */}
              <Route
                path="/workflows/:workflowSlug"
                element={<WorkflowDetail />}
              />

              {/* Workflow list — any authenticated user; the API filters the
                list to workflows they admin. Creating a new one (POST
                /entity-types + /workflows) is admin-only — see
                /workflows/new below. */}
              <Route path="/workflows" element={<Workflows />} />

              {/* Org member list — any authenticated user (admin, agent, or
                customer); the API already allows the "user" role since
                customers need it to resolve assignee display names. */}
              <Route path="/users" element={<UsersPage />} />

              {/* Org chart — any authenticated user can view (docs/specs/
                org-directory.md R7); the manual sync button inside is
                admin-gated client-side, and the sync route itself is
                admin-only server-side. */}
              <Route path="/org-directory" element={<OrgDirectoryPage />} />

              {/* Admin-only routes */}
              <Route element={<RequireAdmin />}>
                <Route path="/workflows/new" element={<CreateWorkflow />} />
                <Route
                  path="/entity-types/:id"
                  element={<EntityTypeDetail />}
                />
                <Route
                  path="/entity-types/:id/records/new"
                  element={<EntityInstanceCreate />}
                />
                <Route path="/admin/system-logs" element={<SystemLogsPage />} />
                <Route
                  path="/admin/third-party-access-logs"
                  element={<ThirdPartyAccessLogsPage />}
                />
                <Route path="/admin/api-keys" element={<ApiKeysPage />} />
                <Route
                  path="/admin/api-keys/:slug"
                  element={<ApiKeyApplicationDetail />}
                />
                <Route
                  path="/admin/schedule-rules"
                  element={<ScheduleRulesPage />}
                />
                <Route
                  path="/admin/schedule-rules/:id"
                  element={<ScheduleRuleDetailPage />}
                />
                {/* Combined tabbed hub (Teams | Services | Roster | Notification
                  Policies) — the sidebar links here now. The 4 individual
                  routes below stay mounted so existing bookmarks/direct
                  links to e.g. /admin/teams keep working. */}
                <Route path="/admin/on-call" element={<OnCallAdminPage />} />
                <Route path="/admin/teams" element={<TeamsPage />} />
                <Route path="/admin/services" element={<ServicesPage />} />
                <Route path="/admin/roster" element={<RosterPage />} />
                <Route
                  path="/admin/notification-policies"
                  element={<NotificationPoliciesPage />}
                />
              </Route>

              <Route
                path="/home"
                element={<Navigate to="/records" replace />}
              />

              {/* Catch-all — an unmatched path (removed route, typo, stale
                bookmark) redirects to Records instead of rendering blank. */}
              <Route path="*" element={<Navigate to="/records" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </Refine>
    </BrowserRouter>
  );
}
