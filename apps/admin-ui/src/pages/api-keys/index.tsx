import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@platform/ui";
import { fetchWithAuth, API_URL } from "../../lib/api.js";
import { ConfirmDeleteDialog } from "../../components/confirm-delete-dialog.js";
import { showAlert } from "../../components/global-alert-dialog.js";
import { CreateApiKeyModal } from "./create.js";
import { EditApiKeyModal } from "./edit.js";
import { KeyRevealModal } from "./key-reveal.js";
import {
  useApiKeyActions,
  API_KEY_ACTION_CONFIRM_COPY,
  type ApiKeyActionKind,
} from "../../hooks/use-api-key-actions.js";
import {
  computeApiKeyStatus,
  computeExpiryBadge,
  summarizeScopes,
  type ApiKeyRow,
} from "./status.js";

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  rotating: "Rotating",
  expired: "Expired",
  revoked: "Revoked",
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
        aria-label="More actions"
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

export function ApiKeys(): React.ReactElement {
  // Refine's dataProvider.getList doesn't forward query params from `meta`,
  // and this screen specifically needs the opt-in `includeRevoked=true` param
  // (see list.ts) to show the full lifecycle per R10 — fetched directly
  // instead, same non-CRUD pattern already used by use-file-upload.ts.
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
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
        showAlert("Failed to load API keys.");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // "Created by" stores the raw Zitadel user ID (createdBy on the api_keys
  // row) — resolved to a display name here via the same /users endpoint
  // user-ref-picker.tsx already uses for the identical id-vs-name problem.
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
      else showAlert("Failed to revoke the key.");
    } else if (kind === "rotate") {
      const result = await rotate(id);
      if (result) {
        refresh();
        setRevealKey({ title: "Key rotated", rawKey: result.key });
      } else {
        showAlert("Failed to rotate the key.");
      }
    } else {
      const result = await emergencyRotate(id);
      if (result) {
        refresh();
        setRevealKey({ title: "Key emergency-rotated", rawKey: result.key });
      } else {
        showAlert("Failed to emergency-rotate the key.");
      }
    }
    setConfirmState(null);
  }

  if (isLoading) {
    return (
      <div className="loading-center">
        <div className="spinner" />
        <span className="loader-text">Loading API keys…</span>
      </div>
    );
  }

  // Newest first — a rotation's dying predecessor and its new successor both
  // show near the top together, instead of the predecessor sitting wherever
  // it was originally created.
  const sortedKeys = [...keys].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

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

      {keys.length === 0 ? (
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
        <div className="rcd-table-wrap">
          <table className="rcd-table" style={{ whiteSpace: "nowrap" }}>
            <thead>
              <tr>
                <th>Application</th>
                <th>Created by</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Scopes</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedKeys.map((key) => {
                const status = computeApiKeyStatus(key, keys);
                const badge = computeExpiryBadge(key.expiresAt);
                const isBusy = busyKeyId === key.id;
                const isRevoked = status === "revoked";
                const menuOpen = openMenuId === key.id;
                return (
                  <tr key={key.id}>
                    <td>{key.applicationName ?? key.name}</td>
                    <td>
                      {key.createdBy
                        ? (userNames[key.createdBy] ?? key.createdBy)
                        : "—"}
                    </td>
                    <td>{formatDateTime(key.createdAt)}</td>
                    <td>
                      {key.expiresAt ? formatDateTime(key.expiresAt) : "Never"}
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
                    <td>{summarizeScopes(key.scopes, key.scopesFormat)}</td>
                    <td>
                      <span
                        className={`wfl-status-badge ${status === "active" ? "wfl-status-active" : "wfl-status-inactive"}`}
                      >
                        <span className="wfl-status-dot" />
                        {STATUS_LABEL[status]}
                      </span>
                    </td>
                    <td>
                      {!isRevoked && (
                        <RowActionsMenu
                          disabled={isBusy}
                          open={menuOpen}
                          onToggle={() =>
                            setOpenMenuId(menuOpen ? null : key.id)
                          }
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
                            Edit
                          </button>
                          <button
                            type="button"
                            className="rcd-kebab-menu-item"
                            onClick={() => {
                              setOpenMenuId(null);
                              setConfirmState({ id: key.id, kind: "rotate" });
                            }}
                          >
                            Rotate
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
                            Emergency Rotate
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
                            Revoke
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
      )}

      <ConfirmDeleteDialog
        open={confirmState !== null}
        {...(confirmState
          ? { title: API_KEY_ACTION_CONFIRM_COPY[confirmState.kind].title }
          : {})}
        message={
          confirmState
            ? API_KEY_ACTION_CONFIRM_COPY[confirmState.kind].message
            : ""
        }
        confirmLabel={
          confirmState
            ? API_KEY_ACTION_CONFIRM_COPY[confirmState.kind].confirmLabel
            : "Confirm"
        }
        busyLabel={
          confirmState
            ? API_KEY_ACTION_CONFIRM_COPY[confirmState.kind].busyLabel
            : "Working…"
        }
        busy={confirmState !== null && busyKeyId === confirmState.id}
        onConfirm={() => void handleConfirm()}
        onCancel={() => setConfirmState(null)}
      />

      <CreateApiKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          refresh();
        }}
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
