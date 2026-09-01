import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { CreateApiKeyModal } from "./create.js";
import {
  computeApiKeyStatus,
  type ApiKeyRow,
  type ApiKeyStatus,
} from "./status.js";
import {
  groupKeysByApplication,
  type ApplicationGroup,
} from "./application-grouping.js";

const STATUS_LABEL: Record<ApiKeyStatus, string> = {
  active: "Active",
  rotating: "Rotating",
  expired: "Expired",
  revoked: "Revoked",
};

// Same palette/order as pages/records/index.tsx's WorkflowCard (CARD_GRADIENTS)
// — kept as its own small local copy rather than importing across pages/,
// per this codebase's own "three similar lines beats a premature shared
// module" convention; the two card designs are visually related but not
// meant to stay byte-for-byte coupled forever.
const CARD_GRADIENTS = [
  "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
  "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  "linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)",
];

const STATUS_PILL_COLOR: Record<ApiKeyStatus, string> = {
  active: "#22c55e",
  rotating: "#f59e0b",
  expired: "#f97316",
  revoked: "#94a3b8",
};

function KeyIcon(): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="#fff"
      style={{ width: "32px", height: "32px" }}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
      />
    </svg>
  );
}

function ApplicationCard({
  app,
  gradient,
  allKeys,
  onNavigate,
}: {
  app: ApplicationGroup;
  gradient: string;
  allKeys: readonly ApiKeyRow[];
  onNavigate: (slug: string) => void;
}): React.ReactElement {
  // Per-key status breakdown, deduplicated and ordered active-first — a
  // quick "what's going on with this application" read without opening it.
  const statusOrder: ApiKeyStatus[] = [
    "active",
    "rotating",
    "expired",
    "revoked",
  ];
  const presentStatuses = statusOrder.filter((s) =>
    app.keys.some((k) => computeApiKeyStatus(k, allKeys) === s),
  );
  const mostRecentCreatedAt = app.keys[0]?.createdAt;

  return (
    <div
      onClick={() => onNavigate(app.slug)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onNavigate(app.slug);
      }}
      style={{
        height: "280px",
        display: "flex",
        flexDirection: "column",
        borderRadius: "16px",
        overflow: "hidden",
        cursor: "pointer",
        border: "1px solid var(--border-color)",
        background: "var(--bg-secondary)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      {/* Gradient header — fixed height, top portion, same shape as the
          Records page's WorkflowCard. */}
      <div
        style={{
          height: "140px",
          flexShrink: 0,
          background: gradient,
          padding: "20px 24px 16px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            background: "rgba(255,255,255,.25)",
            backdropFilter: "blur(4px)",
            borderRadius: "20px",
            padding: "2px 10px",
            fontSize: "11px",
            fontWeight: 600,
            color: "#fff",
          }}
        >
          {app.keys.length} key{app.keys.length !== 1 ? "s" : ""}
        </div>
        <div style={{ marginBottom: "8px" }}>
          <KeyIcon />
        </div>
        <div
          style={{
            fontSize: "17px",
            fontWeight: 700,
            color: "#fff",
            lineHeight: 1.25,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {app.displayName}
        </div>
      </div>

      {/* Card body — bottom portion, fills remaining fixed height. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: "16px 20px 20px",
          overflow: "hidden",
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {presentStatuses.map((status) => (
              <span
                key={status}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  padding: "2px 8px",
                  borderRadius: "20px",
                  fontSize: "11px",
                  fontWeight: 500,
                  background: `${STATUS_PILL_COLOR[status]}22`,
                  color: STATUS_PILL_COLOR[status],
                  border: `1px solid ${STATUS_PILL_COLOR[status]}44`,
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: STATUS_PILL_COLOR[status],
                    flexShrink: 0,
                  }}
                />
                {STATUS_LABEL[status]}
              </span>
            ))}
          </div>
          {mostRecentCreatedAt && (
            <div
              className="page-subtitle"
              style={{ margin: "10px 0 0", fontSize: "12px" }}
            >
              Newest key created{" "}
              {new Date(mostRecentCreatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </div>
          )}
        </div>

        <Button
          variant="primary"
          style={{
            width: "100%",
            justifyContent: "center",
            marginTop: "16px",
            flexShrink: 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(app.slug);
          }}
        >
          View Application →
        </Button>
      </div>
    </div>
  );
}

/**
 * ApiKeys — card grid, one card per unique application (grouped by
 * normalized applicationName, migration 0086's own uniqueness rule). Click
 * a card to see that application's full key history (created/expired/
 * revoked/rotated) and its access logs — see detail.tsx. Card design
 * mirrors pages/records/index.tsx's WorkflowCard (gradient header, fixed
 * height, status pills, pinned CTA button).
 */
export function ApiKeys(): React.ReactElement {
  const navigate = useNavigate();
  // Refine's dataProvider.getList doesn't forward query params from `meta`,
  // and this screen specifically needs the opt-in `includeRevoked=true` param
  // (see list.ts) to show the full lifecycle per R10 — fetched directly
  // instead, same non-CRUD pattern already used by use-file-upload.ts.
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback((): void => {
    setIsLoading(true);
    fetchWithAuth(`${API_URL}/api-keys?includeRevoked=true`)
      .then((res) => {
        setKeys((res as { data: ApiKeyRow[] }).data);
      })
      .catch(() => {
        showAlert("Failed to load API keys.");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function goToApplication(slug: string): void {
    navigate(`/admin/api-keys/${encodeURIComponent(slug)}`);
  }

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading API keys…</span>
      </div>
    );
  }

  const applications = groupKeysByApplication(keys);

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">API Keys</h2>
          <p className="page-subtitle">
            Third-party applications that can create and manage tickets via the
            API, without a human logging in.
          </p>
        </div>
        <div className="wfl-header-actions">
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            New Key
          </Button>
        </div>
      </div>

      {applications.length === 0 ? (
        <div className="wfl-empty">
          <h4>No API keys yet</h4>
          <p>Create one to let a third-party application access tickets.</p>
          <Button
            variant="primary"
            style={{ marginTop: "16px" }}
            onClick={() => setCreateOpen(true)}
          >
            Create your first key
          </Button>
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: "20px",
          }}
        >
          {applications.map((app, i) => (
            <ApplicationCard
              key={app.slug}
              app={app}
              gradient={CARD_GRADIENTS[i % CARD_GRADIENTS.length] ?? ""}
              allKeys={keys}
              onNavigate={goToApplication}
            />
          ))}
        </div>
      )}

      <CreateApiKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
    </div>
  );
}
