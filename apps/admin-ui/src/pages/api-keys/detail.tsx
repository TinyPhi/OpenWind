import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { ConfirmDeleteDialog } from "../../components/confirm-delete-dialog.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { AccessLogsPanel } from "../../components/access-logs-panel.js";
import { EditApiKeyModal } from "./edit.js";
import { KeyRevealModal } from "./key-reveal.js";
import {
  useApiKeyActions,
  type ApiKeyActionKind,
} from "../../hooks/use-api-key-actions.js";
import {
  computeApiKeyStatus,
  computeExpiryBadge,
  summarizeScopes,
  type ApiKeyRow,
} from "./status.js";
import { groupKeysByApplication } from "./application-grouping.js";

const ACTION_COPY_KEY: Record<ApiKeyActionKind, string> = {
  revoke: "apiKeys.actions.revoke",
  rotate: "apiKeys.actions.rotate",
  "emergency-rotate": "apiKeys.actions.emergencyRotate",
};

const STATUS_LABEL: Record<string, string> = {
  active: "apiKeys.active",
  rotating: "apiKeys.rotating",
  expired: "apiKeys.expired",
  revoked: "apiKeys.revoked",
};

// Date-only formatting hid exactly the detail that matters most on this
// screen — telling apart two events on the same day (e.g. a rotated key's
// ~24h grace-window expiry vs. its successor's ~3-month one) requires the
// time, not just the date.
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * .rcd-kebab-menu is position:absolute inside .rcd-kebab-wrap — fine on a
 * static card, but this table sits in a horizontal-scroll wrapper
 * (overflow-x: auto), which clips any absolutely-positioned descendant that
 * would render outside its bounds regardless of z-index (overflow clipping
 * happens independent of stacking order). Rendered via a portal into
 * document.body instead, with position:fixed computed from the trigger
 * button's own bounding rect, so it's never clipped by an ancestor.
 */
function RowActionsMenu({
  disabled,
  open,
  onToggle,
  onRequestClose,
  children,
}: {
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onRequestClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const { t } = useTranslation();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(
    null,
  );

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setCoords({
      top: rect.bottom + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  return (
    <div className="rcd-kebab-wrap">
      <button
        ref={btnRef}
        type="button"
        className="rcd-kebab-btn"
        aria-label={t("apiKeys.moreActions")}
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {open &&
        coords &&
        createPortal(
          <>
            <div className="rcd-kebab-backdrop" onClick={onRequestClose} />
            <div
              className="rcd-kebab-menu"
              style={{
                position: "fixed",
                top: coords.top,
                right: coords.right,
              }}
            >
              {children}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

export function ApiKeyApplicationDetail(): React.ReactElement {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<ApiKeyRow | null>(null);
  const { busyKeyId, revoke, rotate, emergencyRotate } = useApiKeyActions();
  const [confirmState, setConfirmState] = useState<{
    id: string;
    kind: ApiKeyActionKind;
  } | null>(null);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState<{
    title: string;
    rawKey: string;
  } | null>(null);

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

  useEffect(() => {
    fetchWithAuth(`${API_URL}/users`)
      .then((res) => {
        const list =
          (
            res as {
              data?: Array<{
                userId: string;
                email: string;
                displayName: string | null;
              }>;
            }
          ).data ?? [];
        const map: Record<string, string> = {};
        for (const u of list) map[u.userId] = u.displayName ?? u.email;
        setUserNames(map);
      })
      .catch(() => {
        /* fall back to showing the raw ID below */
      });
  }, []);

  async function handleConfirm(): Promise<void> {
    if (!confirmState) return;
    const { id, kind } = confirmState;
    if (kind === "revoke") {
      const ok = await revoke(id);
      if (ok) refresh();
      else showAlert(t("apiKeys.failedToRevoke"));
    } else if (kind === "rotate") {
      const result = await rotate(id);
      if (result) {
        refresh();
        setRevealKey({ title: t("apiKeys.keyRotated"), rawKey: result.key });
      } else {
        showAlert(t("apiKeys.failedToRotate"));
      }
    } else {
      const result = await emergencyRotate(id);
      if (result) {
        refresh();
        setRevealKey({
          title: t("apiKeys.keyEmergencyRotated"),
          rawKey: result.key,
        });
      } else {
        showAlert(t("apiKeys.failedToEmergencyRotate"));
      }
    }
    setConfirmState(null);
  }

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">{t("apiKeys.loadingApplication")}</span>
      </div>
    );
  }

  const application = groupKeysByApplication(keys).find(
    (app) => app.slug === slug,
  );

  if (!application) {
    return (
      <div className="wfl-empty">
        <h4>{t("apiKeys.applicationNotFound")}</h4>
        <p>{t("apiKeys.applicationNotFoundDesc")}</p>
        <Button
          variant="secondary"
          style={{ marginTop: "16px" }}
          onClick={() => void navigate("/admin/api-keys")}
        >
          {t("apiKeys.backToApiKeys")}
        </Button>
      </div>
    );
  }

  const applicationKeyIds = application.keys.map((k) => k.id);

  return (
    <div>
      <div className="wfl-page-header">
        <div>
          <Button
            variant="secondary"
            style={{ marginBottom: "12px" }}
            onClick={() => void navigate("/admin/api-keys")}
          >
            {t("apiKeys.allApplications")}
          </Button>
          <h2 className="page-title">{application.displayName}</h2>
          <p className="page-subtitle">
            {t("apiKeys.detailSubtitle", { count: application.keys.length })}
          </p>
        </div>
      </div>

      <div className="rcd-table-wrap">
        <table className="rcd-table" style={{ whiteSpace: "nowrap" }}>
          <thead>
            <tr>
              <th>{t("apiKeys.createdBy")}</th>
              <th>{t("apiKeys.created")}</th>
              <th>{t("apiKeys.expires")}</th>
              <th>{t("apiKeys.scopes")}</th>
              <th>{t("apiKeys.statusHeader")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {application.keys.map((key) => {
              const status = computeApiKeyStatus(key, keys);
              const badge = computeExpiryBadge(key.expiresAt, new Date(), t);
              const isBusy = busyKeyId === key.id;
              const isRevoked = status === "revoked";
              const menuOpen = openMenuId === key.id;
              return (
                <tr key={key.id}>
                  <td>
                    {key.createdBy
                      ? (userNames[key.createdBy] ?? key.createdBy)
                      : "—"}
                  </td>
                  <td>{formatDateTime(key.createdAt)}</td>
                  <td>
                    {key.expiresAt
                      ? formatDateTime(key.expiresAt)
                      : t("apiKeys.never")}
                    {badge.level !== "none" && (
                      <span
                        className="stat-pill"
                        style={{
                          marginLeft: 8,
                          color:
                            badge.level === "red"
                              ? "var(--danger, hsl(350, 80%, 60%))"
                              : "var(--warning, hsl(38, 92%, 50%))",
                        }}
                      >
                        {badge.label}
                      </span>
                    )}
                  </td>
                  <td>{summarizeScopes(key.scopes, key.scopesFormat, t)}</td>
                  <td>
                    <span
                      className={`wfl-status-badge ${status === "active" ? "wfl-status-active" : "wfl-status-inactive"}`}
                    >
                      <span className="wfl-status-dot" />
                      {t(STATUS_LABEL[status] ?? "")}
                    </span>
                  </td>
                  <td>
                    {!isRevoked && (
                      <RowActionsMenu
                        disabled={isBusy}
                        open={menuOpen}
                        onToggle={() => setOpenMenuId(menuOpen ? null : key.id)}
                        onRequestClose={() => setOpenMenuId(null)}
                      >
                        <button
                          type="button"
                          className="rcd-kebab-menu-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            setEditingKey(key);
                          }}
                        >
                          {t("apiKeys.edit")}
                        </button>
                        <button
                          type="button"
                          className="rcd-kebab-menu-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            setConfirmState({ id: key.id, kind: "rotate" });
                          }}
                        >
                          {t("apiKeys.rotate")}
                        </button>
                        <button
                          type="button"
                          className="rcd-kebab-menu-item"
                          onClick={() => {
                            setOpenMenuId(null);
                            setConfirmState({
                              id: key.id,
                              kind: "emergency-rotate",
                            });
                          }}
                        >
                          {t("apiKeys.emergencyRotate")}
                        </button>
                        <button
                          type="button"
                          className="rcd-kebab-menu-item"
                          style={{
                            color: "var(--danger, hsl(350, 80%, 60%))",
                          }}
                          onClick={() => {
                            setOpenMenuId(null);
                            setConfirmState({ id: key.id, kind: "revoke" });
                          }}
                        >
                          {t("apiKeys.revoke")}
                        </button>
                      </RowActionsMenu>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: "32px" }}>
        <h3 style={{ marginBottom: "12px" }}>
          {t("apiKeys.accessLogsHeading")}
        </h3>
        <AccessLogsPanel lockedApplicationIds={applicationKeyIds} />
      </div>

      <ConfirmDeleteDialog
        open={confirmState !== null}
        {...(confirmState
          ? { title: t(`${ACTION_COPY_KEY[confirmState.kind]}.title`) }
          : {})}
        message={
          confirmState ? t(`${ACTION_COPY_KEY[confirmState.kind]}.message`) : ""
        }
        confirmLabel={
          confirmState
            ? t(`${ACTION_COPY_KEY[confirmState.kind]}.confirmLabel`)
            : t("apiKeys.confirm")
        }
        busyLabel={
          confirmState
            ? t(`${ACTION_COPY_KEY[confirmState.kind]}.busyLabel`)
            : t("apiKeys.working")
        }
        busy={confirmState !== null && busyKeyId === confirmState.id}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirmState(null)}
      />

      <EditApiKeyModal
        keyRow={editingKey}
        onClose={() => setEditingKey(null)}
        onSaved={() => {
          setEditingKey(null);
          refresh();
        }}
      />

      <KeyRevealModal
        open={revealKey !== null}
        title={revealKey?.title ?? ""}
        rawKey={revealKey?.rawKey ?? null}
        onClose={() => setRevealKey(null)}
      />
    </div>
  );
}
