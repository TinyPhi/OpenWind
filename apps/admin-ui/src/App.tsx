import React from "react";
import { Refine, Authenticated } from "@refinedev/core";
import routerProvider from "@refinedev/react-router-v6";
import {
  BrowserRouter,
  Routes,
  Route,
  Outlet,
  Navigate,
} from "react-router-dom";
import { authProvider } from "./authProvider.js";
import { dataProvider } from "./dataProvider.js";
import { EntityTypeProvider } from "./entity-type-context.js";
import { Layout } from "./components/layout.js";
import { Login } from "./pages/login.js";
import { AuthCallback } from "./pages/callback.js";
import { Dashboard } from "./pages/dashboard.js";
import { Modules } from "./pages/modules.js";
import { EntityTypeDetail } from "./pages/entity-types/detail.js";
import { EntityInstanceCreate } from "./pages/entity-types/instance-create.js";
import { Workflows } from "./pages/workflows/index.js";
import { WorkflowDetail } from "./pages/workflows/detail.js";
import { CreateWorkflow } from "./pages/workflows/create.js";
import { AdminRecords } from "./pages/records/index.js";
import { WorkflowRecords } from "./pages/records/workflow-records.js";
import { Settings } from "./pages/settings.js";
import { UsersPage } from "./pages/users.js";
import { CustomerRecordList } from "./pages/customer/record-list.js";
import { CustomerRecordCreate } from "./pages/customer/record-create.js";
import { CustomerRecordDetail } from "./pages/customer/record-detail.js";
import { Automations } from "./pages/automations/index.js";
import { AutomationWizard } from "./pages/automations/wizard/wizard.js";
import { RequireAdmin } from "./components/require-admin.js";
import "./index.css";

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <Refine
        authProvider={authProvider}
        dataProvider={dataProvider}
        routerProvider={routerProvider}
        resources={[
          {
            name: "dashboard",
            list: "/dashboard",
            meta: { label: "Dashboard" },
          },
          { name: "modules", list: "/modules", meta: { label: "Templates" } },
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
        ]}
      >
        <Routes>
          {/* Auth routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />

          {/* Protected routes */}
          <Route
            element={
              <Authenticated
                key="protected"
                fallback={<Navigate to="/login" />}
              >
                <EntityTypeProvider>
                  <Layout>
                    <Outlet />
                  </Layout>
                </EntityTypeProvider>
              </Authenticated>
            }
          >
            {/* All authenticated users */}
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
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
            <Route path="/records/:typeSlug" element={<CustomerRecordList />} />
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

            {/* Workflow detail — access checked inside component (admin or workflow assignee) */}
            <Route
              path="/workflows/:workflowSlug"
              element={<WorkflowDetail />}
            />

            {/* Admin-only routes */}
            <Route element={<RequireAdmin />}>
              <Route path="/users" element={<UsersPage />} />
              <Route path="/entity-types/:id" element={<EntityTypeDetail />} />
              <Route
                path="/entity-types/:id/records/new"
                element={<EntityInstanceCreate />}
              />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/workflows/new" element={<CreateWorkflow />} />
            </Route>

            <Route path="/home" element={<Navigate to="/records" replace />} />
          </Route>
        </Routes>
      </Refine>
    </BrowserRouter>
  );
}
