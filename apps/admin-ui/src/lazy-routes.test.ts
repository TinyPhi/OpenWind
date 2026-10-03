import { describe, it, expect } from "vitest";
import type React from "react";
import * as LazyRoutes from "./lazy-routes.js";

interface RouteManifestEntry {
  exportName: keyof typeof LazyRoutes;
  modulePath: string;
  namedExport: string;
}

const ROUTE_MANIFEST: readonly RouteManifestEntry[] = [
  // Auth & Shell
  { exportName: "Login", modulePath: "./pages/login.js", namedExport: "Login" },
  {
    exportName: "AuthCallback",
    modulePath: "./pages/callback.js",
    namedExport: "AuthCallback",
  },
  {
    exportName: "Dashboard",
    modulePath: "./pages/dashboard.js",
    namedExport: "Dashboard",
  },
  {
    exportName: "Analytics",
    modulePath: "./pages/analytics.js",
    namedExport: "Analytics",
  },
  {
    exportName: "ReportingPage",
    modulePath: "./pages/reporting.js",
    namedExport: "ReportingPage",
  },

  // Core Workflows & Records
  {
    exportName: "Workflows",
    modulePath: "./pages/workflows/index.js",
    namedExport: "Workflows",
  },
  {
    exportName: "WorkflowDetail",
    modulePath: "./pages/workflows/detail.js",
    namedExport: "WorkflowDetail",
  },
  {
    exportName: "CreateWorkflow",
    modulePath: "./pages/workflows/create.js",
    namedExport: "CreateWorkflow",
  },
  {
    exportName: "AdminRecords",
    modulePath: "./pages/records/index.js",
    namedExport: "AdminRecords",
  },
  {
    exportName: "WorkflowRecords",
    modulePath: "./pages/records/workflow-records.js",
    namedExport: "WorkflowRecords",
  },

  // Customer Tickets
  {
    exportName: "CustomerRecordCreate",
    modulePath: "./pages/customer/record-create.js",
    namedExport: "CustomerRecordCreate",
  },
  {
    exportName: "CustomerRecordDetail",
    modulePath: "./pages/customer/record-detail.js",
    namedExport: "CustomerRecordDetail",
  },

  // Automations & Settings
  {
    exportName: "Automations",
    modulePath: "./pages/automations/index.js",
    namedExport: "Automations",
  },
  {
    exportName: "AutomationWizard",
    modulePath: "./pages/automations/wizard/wizard.js",
    namedExport: "AutomationWizard",
  },
  {
    exportName: "Settings",
    modulePath: "./pages/settings.js",
    namedExport: "Settings",
  },
  {
    exportName: "Modules",
    modulePath: "./pages/modules.js",
    namedExport: "Modules",
  },
  {
    exportName: "Plugins",
    modulePath: "./pages/plugins.js",
    namedExport: "Plugins",
  },
  {
    exportName: "UsersPage",
    modulePath: "./pages/users.js",
    namedExport: "UsersPage",
  },
  {
    exportName: "OrgDirectoryPage",
    modulePath: "./pages/org-directory.js",
    namedExport: "OrgDirectoryPage",
  },

  // Entities & Admin Hubs
  {
    exportName: "EntityTypeDetail",
    modulePath: "./pages/entity-types/detail.js",
    namedExport: "EntityTypeDetail",
  },
  {
    exportName: "EntityInstanceCreate",
    modulePath: "./pages/entity-types/instance-create.js",
    namedExport: "EntityInstanceCreate",
  },
  {
    exportName: "SystemLogsPage",
    modulePath: "./pages/system-logs.js",
    namedExport: "SystemLogsPage",
  },
  {
    exportName: "ThirdPartyAccessLogsPage",
    modulePath: "./pages/third-party-access-logs.js",
    namedExport: "ThirdPartyAccessLogsPage",
  },
  {
    exportName: "ApiKeysPage",
    modulePath: "./pages/api-keys/page.js",
    namedExport: "ApiKeysPage",
  },
  {
    exportName: "ApiKeyApplicationDetail",
    modulePath: "./pages/api-keys/detail.js",
    namedExport: "ApiKeyApplicationDetail",
  },
  {
    exportName: "ScheduleRulesPage",
    modulePath: "./pages/schedule-rules/index.js",
    namedExport: "ScheduleRulesPage",
  },
  {
    exportName: "ScheduleRuleDetailPage",
    modulePath: "./pages/schedule-rules/detail.js",
    namedExport: "ScheduleRuleDetailPage",
  },
  {
    exportName: "TeamsPage",
    modulePath: "./pages/teams/index.js",
    namedExport: "TeamsPage",
  },
  {
    exportName: "ServicesPage",
    modulePath: "./pages/services/index.js",
    namedExport: "ServicesPage",
  },
  {
    exportName: "RosterPage",
    modulePath: "./pages/roster/index.js",
    namedExport: "RosterPage",
  },
  {
    exportName: "NotificationPoliciesPage",
    modulePath: "./pages/notification-policies/index.js",
    namedExport: "NotificationPoliciesPage",
  },
  {
    exportName: "OnCallAdminPage",
    modulePath: "./pages/admin-oncall/index.js",
    namedExport: "OnCallAdminPage",
  },
];

describe("lazy-routes completeness and integrity", () => {
  it("exports exactly 32 lazy route components", () => {
    expect(ROUTE_MANIFEST.length).toBe(32);
    expect(Object.keys(LazyRoutes).length).toBe(32);
  });

  for (const entry of ROUTE_MANIFEST) {
    it(`lazy export '${entry.exportName}' is a valid React.lazy component`, () => {
      const lazyComponent = LazyRoutes[entry.exportName];
      expect(lazyComponent).toBeDefined();
      expect(typeof lazyComponent).toBe("object");
      // React.lazy components have $$typeof Symbol(react.lazy)
      const symbolOrProp = (lazyComponent as { $$typeof?: symbol }).$$typeof;
      expect(symbolOrProp).toBe(Symbol.for("react.lazy"));
    });

    it(`target module '${entry.modulePath}' exports '${entry.namedExport}' as a component`, async () => {
      const mod = await import(/* @vite-ignore */ entry.modulePath);
      expect(mod).toBeDefined();
      const exportedItem = mod[entry.namedExport] as
        | React.ComponentType
        | undefined;
      expect(exportedItem).toBeDefined();
      expect(
        typeof exportedItem === "function" || typeof exportedItem === "object",
      ).toBe(true);
    });
  }
});
