import { lazy } from "react";

// Auth & Shell
export const Login = lazy(() =>
  import("./pages/login.js").then((m) => ({ default: m.Login })),
);
export const AuthCallback = lazy(() =>
  import("./pages/callback.js").then((m) => ({ default: m.AuthCallback })),
);
export const Dashboard = lazy(() =>
  import("./pages/dashboard.js").then((m) => ({ default: m.Dashboard })),
);
export const Analytics = lazy(() =>
  import("./pages/analytics.js").then((m) => ({ default: m.Analytics })),
);
export const ReportingPage = lazy(() =>
  import("./pages/reporting.js").then((m) => ({ default: m.ReportingPage })),
);

// Core Workflows & Records
export const Workflows = lazy(() =>
  import("./pages/workflows/index.js").then((m) => ({ default: m.Workflows })),
);
export const WorkflowDetail = lazy(() =>
  import("./pages/workflows/detail.js").then((m) => ({
    default: m.WorkflowDetail,
  })),
);
export const CreateWorkflow = lazy(() =>
  import("./pages/workflows/create.js").then((m) => ({
    default: m.CreateWorkflow,
  })),
);
export const AdminRecords = lazy(() =>
  import("./pages/records/index.js").then((m) => ({
    default: m.AdminRecords,
  })),
);
export const WorkflowRecords = lazy(() =>
  import("./pages/records/workflow-records.js").then((m) => ({
    default: m.WorkflowRecords,
  })),
);

// Customer Tickets
export const CustomerRecordCreate = lazy(() =>
  import("./pages/customer/record-create.js").then((m) => ({
    default: m.CustomerRecordCreate,
  })),
);
export const CustomerRecordDetail = lazy(() =>
  import("./pages/customer/record-detail.js").then((m) => ({
    default: m.CustomerRecordDetail,
  })),
);

// Automations & Settings
export const Automations = lazy(() =>
  import("./pages/automations/index.js").then((m) => ({
    default: m.Automations,
  })),
);
export const AutomationWizard = lazy(() =>
  import("./pages/automations/wizard/wizard.js").then((m) => ({
    default: m.AutomationWizard,
  })),
);
export const Settings = lazy(() =>
  import("./pages/settings.js").then((m) => ({ default: m.Settings })),
);
export const Modules = lazy(() =>
  import("./pages/modules.js").then((m) => ({ default: m.Modules })),
);
export const Plugins = lazy(() =>
  import("./pages/plugins.js").then((m) => ({ default: m.Plugins })),
);
export const UsersPage = lazy(() =>
  import("./pages/users.js").then((m) => ({ default: m.UsersPage })),
);
export const OrgDirectoryPage = lazy(() =>
  import("./pages/org-directory.js").then((m) => ({
    default: m.OrgDirectoryPage,
  })),
);

// Entities & Admin Hubs
export const EntityTypeDetail = lazy(() =>
  import("./pages/entity-types/detail.js").then((m) => ({
    default: m.EntityTypeDetail,
  })),
);
export const EntityInstanceCreate = lazy(() =>
  import("./pages/entity-types/instance-create.js").then((m) => ({
    default: m.EntityInstanceCreate,
  })),
);
export const SystemLogsPage = lazy(() =>
  import("./pages/system-logs.js").then((m) => ({
    default: m.SystemLogsPage,
  })),
);
export const ThirdPartyAccessLogsPage = lazy(() =>
  import("./pages/third-party-access-logs.js").then((m) => ({
    default: m.ThirdPartyAccessLogsPage,
  })),
);
export const ApiKeysPage = lazy(() =>
  import("./pages/api-keys/page.js").then((m) => ({ default: m.ApiKeysPage })),
);
export const ApiKeyApplicationDetail = lazy(() =>
  import("./pages/api-keys/detail.js").then((m) => ({
    default: m.ApiKeyApplicationDetail,
  })),
);
export const ScheduleRulesPage = lazy(() =>
  import("./pages/schedule-rules/index.js").then((m) => ({
    default: m.ScheduleRulesPage,
  })),
);
export const ScheduleRuleDetailPage = lazy(() =>
  import("./pages/schedule-rules/detail.js").then((m) => ({
    default: m.ScheduleRuleDetailPage,
  })),
);
export const TeamsPage = lazy(() =>
  import("./pages/teams/index.js").then((m) => ({ default: m.TeamsPage })),
);
export const ServicesPage = lazy(() =>
  import("./pages/services/index.js").then((m) => ({
    default: m.ServicesPage,
  })),
);
export const RosterPage = lazy(() =>
  import("./pages/roster/index.js").then((m) => ({ default: m.RosterPage })),
);
export const NotificationPoliciesPage = lazy(() =>
  import("./pages/notification-policies/index.js").then((m) => ({
    default: m.NotificationPoliciesPage,
  })),
);
export const OnCallAdminPage = lazy(() =>
  import("./pages/admin-oncall/index.js").then((m) => ({
    default: m.OnCallAdminPage,
  })),
);
