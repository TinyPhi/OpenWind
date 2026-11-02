import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@platform/ui";
import { useTranslation } from "react-i18next";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { CreateApiKeyModal } from "./create.js";
import type { ApiKeyRow } from "./status.js";
import { groupKeysByApplication } from "./application-grouping.js";

const STATUS_LABEL: Record<string, string> = {
  active: "apiKeys.active",
  rotating: "apiKeys.rotating",
  expired: "apiKeys.expired",
  revoked: "apiKeys.revoked",
};

/**
 * ApiKeys — card grid, one card per unique application (grouped by
 * normalized applicationName, migration 0087's own uniqueness rule). Click
 * a card to see that application's full key history (created/expired/
 * revoked/rotated) and its access logs — see detail.tsx.
 */
export function ApiKeys(): React.ReactElement {
  const { t } = useTranslation();
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
        showAlert(t("apiKeys.failedToLoad"));
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">{t("apiKeys.loading")}</span>
      </div>
    );
  }

  const applications = groupKeysByApplication(keys);

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <h2 className="page-title">{t("apiKeys.title")}</h2>
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
          <h4>{t("apiKeys.noKeys")}</h4>
          <p>{t("apiKeys.noKeysDesc")}</p>
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
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "16px",
          }}
        >
          {applications.map((app) => (
            <button
              key={app.slug}
              type="button"
              className="data-panel"
              onClick={() =>
                void navigate(`/admin/api-keys/${encodeURIComponent(app.slug)}`)
              }
              style={{
                padding: "16px",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: "15px",
                    wordBreak: "break-word",
                  }}
                >
                  {app.displayName}
                </span>
                <span
                  className={`wfl-status-badge ${app.status === "active" ? "wfl-status-active" : "wfl-status-inactive"}`}
                  style={{ flexShrink: 0 }}
                >
                  <span className="wfl-status-dot" />
                  {t(STATUS_LABEL[app.status] ?? "")}
                </span>
              </div>
              <span className="page-subtitle" style={{ margin: 0 }}>
                {app.keys.length} key{app.keys.length !== 1 ? "s" : ""}
              </span>
            </button>
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
