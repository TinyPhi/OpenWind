import React, { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";

const TeamsPage = lazy(() =>
  import("../teams/index.js").then((m) => ({ default: m.TeamsPage })),
);
const ServicesPage = lazy(() =>
  import("../services/index.js").then((m) => ({ default: m.ServicesPage })),
);
const RosterPage = lazy(() =>
  import("../roster/index.js").then((m) => ({ default: m.RosterPage })),
);
const NotificationPoliciesPage = lazy(() =>
  import("../notification-policies/index.js").then((m) => ({
    default: m.NotificationPoliciesPage,
  })),
);

// Combines the 4 on-call-routing admin pages (docs/specs/oncall-routing.md)
// into one tabbed page — they're tightly coupled (services belong to teams,
// the roster assigns on-call people per service, notification policies
// decide who/how gets alerted) and were cluttering the sidebar as 4
// separate top-level entries.
const TABS = [
  { id: "teams", label: "Teams" },
  { id: "services", label: "Services" },
  { id: "roster", label: "On-Call Roster" },
  { id: "policies", label: "Notification Policies" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function OnCallAdminPage(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get("tab") ?? "teams") as TabId;

  function setActiveTab(id: TabId): void {
    setSearchParams({ tab: id });
  }

  return (
    <div>
      <div
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-color)",
          borderBottom: "none",
          borderTopLeftRadius: "8px",
          borderTopRightRadius: "8px",
          display: "flex",
          gap: "0",
          overflowX: "auto",
          marginBottom: "20px",
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              padding: "12px 20px",
              fontSize: "13px",
              fontWeight: activeTab === tab.id ? 700 : 500,
              color:
                activeTab === tab.id
                  ? "var(--accent-primary)"
                  : "var(--text-secondary)",
              background: "none",
              border: "none",
              borderBottom:
                activeTab === tab.id
                  ? "2px solid var(--accent-primary)"
                  : "2px solid transparent",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "color 0.15s, border-color 0.15s",
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Suspense
        fallback={
          <div className="loading-center">
            <div className="spinner" />
            <span className="loader-text">Loading…</span>
          </div>
        }
      >
        {activeTab === "teams" && <TeamsPage />}
        {activeTab === "services" && <ServicesPage />}
        {activeTab === "roster" && <RosterPage />}
        {activeTab === "policies" && <NotificationPoliciesPage />}
      </Suspense>
    </div>
  );
}
