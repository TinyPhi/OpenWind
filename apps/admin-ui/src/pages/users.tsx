import React, { useEffect, useState } from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TOKENS,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager } from "../authProvider.js";
import { initials } from "../lib/format.js";
import { avatarColor } from "../lib/theme.js";
import { OrgChartPanel } from "./org-directory.js";
import { ConfirmDeleteDialog } from "../components/confirm-delete-dialog.js";
import { showAlert } from "../components/global-alert-dialog.js";
import { showToast, type ToastTone } from "../components/toast.js";

function getRolesFromProfile(
  profile: Record<string, unknown> | undefined,
): string[] {
  if (!profile) return [];
  const rolesMap = (profile["urn:zitadel:iam:org:project:roles"] ??
    {}) as Record<string, unknown>;
  return Object.keys(rolesMap);
}

declare const window: Window & { __CONFIG__?: Record<string, string> };
const ZITADEL_ISSUER =
  window.__CONFIG__?.ZITADEL_ISSUER ?? "http://localhost:8080";

function zitadelUserUrl(userId: string): string {
  return `${ZITADEL_ISSUER}/ui/console/users/${userId}`;
}

interface User {
  userId: string;
  displayName: string;
  email: string;
  loginName: string;
  roles?: string[];
}

interface UserRowProps {
  user: User;
  isAdmin: boolean;
  /** Set only where erasing is allowed: an admin, and never on their own row. */
  onErase?: (() => void) | undefined;
  erasing?: boolean;
}

/** The name an admin types to confirm an erasure: what the row shows first. */
function eraseConfirmText(user: User): string {
  return user.displayName.trim() || user.loginName || user.email;
}

/**
 * The API's own sentence about Superset (#728) when it gives one. `queued` and `cache_only` mean
 * the Superset side is being handled; anything else means it was not, which the admin should see.
 */
function supersetToast(
  superset: { status?: string; message?: string } | undefined,
): { message?: string; tone: ToastTone } {
  if (!superset?.message) return { tone: "success" };
  const handled =
    superset.status === "queued" || superset.status === "cache_only";
  return { message: superset.message, tone: handled ? "success" : "warning" };
}

function UserRow({
  user,
  isAdmin,
  onErase,
  erasing = false,
}: UserRowProps): React.ReactElement {
  const color = avatarColor(user.userId);

  return (
    <TableRow className="interactive-hover-row">
      <TableCell style={{ padding: "12px 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              background: color,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "12px",
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {initials(user.displayName)}
          </div>
          <span
            style={{
              fontSize: "14px",
              fontWeight: 500,
              color: TOKENS.textPrimary,
            }}
          >
            {user.displayName}
          </span>
        </div>
      </TableCell>
      <TableCell
        style={{
          padding: "12px 16px",
          fontSize: "13px",
          color: TOKENS.textSecondary,
        }}
      >
        {user.loginName}
      </TableCell>
      <TableCell
        style={{
          padding: "12px 16px",
          fontSize: "13px",
          color: TOKENS.textSecondary,
        }}
      >
        {user.email}
      </TableCell>
      <TableCell style={{ padding: "12px 16px" }}>
        <div
          style={{
            display: "flex",
            gap: "6px",
            flexWrap: "wrap",
          }}
        >
          {(user.roles ?? []).length === 0 ? (
            <span
              style={{
                fontSize: "12px",
                color: TOKENS.textMuted,
              }}
            >
              —
            </span>
          ) : (
            (user.roles ?? []).map((role) => (
              <span
                key={role}
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: TOKENS.bgTertiary,
                  color: TOKENS.textSecondary,
                  textTransform: "capitalize",
                }}
              >
                {role}
              </span>
            ))
          )}
        </div>
      </TableCell>
      <TableCell
        style={{
          padding: "12px 16px",
          fontSize: "11px",
          color: TOKENS.textMuted,
          fontFamily: "monospace",
        }}
      >
        {user.userId}
      </TableCell>
      {isAdmin && (
        <TableCell style={{ padding: "12px 16px", textAlign: "right" }}>
          {onErase && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onErase}
              disabled={erasing}
              title="Erase this user's personal data"
              aria-label={`Erase ${eraseConfirmText(user)}`}
              style={{
                marginRight: "8px",
                padding: "4px 10px",
                fontSize: "12px",
                color: "var(--danger, hsl(350, 80%, 60%))",
              }}
            >
              {erasing ? "Erasing…" : "Erase"}
            </button>
          )}
          <a
            href={zitadelUserUrl(user.userId)}
            target="_blank"
            rel="noreferrer"
            title="Open in Zitadel"
            className="user-icon-action"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "28px",
              height: "28px",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
              />
            </svg>
          </a>
        </TableCell>
      )}
    </TableRow>
  );
}

export function UsersPage(): React.ReactElement {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [showOrgChart, setShowOrgChart] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [eraseTarget, setEraseTarget] = useState<User | null>(null);
  const [erasingId, setErasingId] = useState<string | null>(null);
  const isAdmin = roles.includes("admin");

  useEffect(() => {
    void userManager.getUser().then((u) => {
      setRoles(
        getRolesFromProfile(u?.profile as Record<string, unknown> | undefined),
      );
      const sub = (u?.profile as { sub?: unknown } | undefined)?.sub;
      setCurrentUserId(typeof sub === "string" ? sub : null);
    });
  }, []);

  // DELETE /users/:userId is the GDPR erasure (admin-only on the server). The dialog closes before
  // the request (see ConfirmDeleteDialog), so the row's button shows the progress instead.
  const eraseUser = async (user: User): Promise<void> => {
    const name = eraseConfirmText(user);
    setEraseTarget(null);
    setErasingId(user.userId);
    try {
      const res = (await fetchWithAuth(
        `${API_URL}/users/${encodeURIComponent(user.userId)}`,
        { method: "DELETE" },
      )) as { superset?: { status?: string; message?: string } } | undefined;
      setUsers((all) => all.filter((u) => u.userId !== user.userId));
      const superset = supersetToast(res?.superset);
      showToast({
        title: `${name} was erased.`,
        message: superset.message,
        tone: superset.tone,
      });
    } catch (err) {
      // The data is gone but the sign-in is not: the user stays listed (they can still sign in),
      // and erasing again retries the sign-in removal.
      if ((err as { code?: string }).code === "SIGN_IN_NOT_REMOVED") {
        showAlert(
          `${name}'s data was erased, but their sign-in could not be removed, so they can still sign in. Erase them again to retry.`,
          "Erase incomplete",
        );
        return;
      }
      showAlert(
        `${name} was not erased: ${err instanceof Error ? err.message : "the request failed"}.`,
        "Erase failed",
      );
    } finally {
      setErasingId(null);
    }
  };

  useEffect(() => {
    fetchWithAuth(`${API_URL}/users`)
      .then((res) => {
        setUsers((res as { data: User[] }).data);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load users"),
      )
      .finally(() => setLoading(false));
  }, []);

  const filtered = query.trim()
    ? users.filter(
        (u) =>
          u.displayName.toLowerCase().includes(query.toLowerCase()) ||
          u.email.toLowerCase().includes(query.toLowerCase()) ||
          u.loginName.toLowerCase().includes(query.toLowerCase()),
      )
    : users;

  return (
    <div>
      {showOrgChart && (
        <div className="modal-overlay" onClick={() => setShowOrgChart(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Org chart"
            style={{ maxWidth: "1200px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">Org Chart</h3>
              <button
                type="button"
                className="modal-close"
                aria-label="Close"
                onClick={() => setShowOrgChart(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <OrgChartPanel embedded />
            </div>
          </div>
        </div>
      )}
      <ConfirmDeleteDialog
        open={eraseTarget !== null}
        title="Erase this user?"
        message={
          eraseTarget ? (
            <>
              This permanently erases{" "}
              <strong>{eraseConfirmText(eraseTarget)}</strong>&apos;s personal
              data from your organization and deletes their sign-in account.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Erase"
        typeToConfirm={eraseTarget ? eraseConfirmText(eraseTarget) : undefined}
        onConfirm={() => {
          if (eraseTarget) void eraseUser(eraseTarget);
        }}
        onCancel={() => setEraseTarget(null)}
      />
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "24px",
        }}
      >
        <div>
          <h2 className="page-title">Users</h2>
          <p className="page-subtitle">
            All members of your organization, sorted alphabetically.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowOrgChart(true)}
        >
          View org chart
        </button>
      </div>

      {/* Search */}
      <div
        style={{
          position: "relative",
          maxWidth: "340px",
          marginBottom: "20px",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{
            position: "absolute",
            left: "10px",
            top: "50%",
            transform: "translateY(-50%)",
            opacity: 0.4,
            pointerEvents: "none",
          }}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email…"
          className="form-input"
          style={{ paddingLeft: "32px" }}
        />
      </div>

      {loading && (
        <div className="loading-center">
          <div className="spinner" />
          <span className="loader-text">Loading users…</span>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">👥</div>
          <div className="empty-state-title">
            {query ? "No users match your search" : "No users found"}
          </div>
          <div className="empty-state-subtitle">
            {query
              ? "Try a different search term."
              : "Users appear here after they log in, or when Zitadel is connected."}
          </div>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div
          className="data-panel"
          style={{ overflowX: "auto", overflowY: "hidden" }}
        >
          <Table scroll={false} style={{ whiteSpace: "nowrap" }}>
            <TableHeader>
              <TableRow>
                {[
                  "Name",
                  "Login",
                  "Email",
                  "Roles",
                  "User ID",
                  ...(isAdmin ? [""] : []),
                ].map((h) => (
                  <TableHead
                    key={h}
                    style={{
                      padding: "10px 16px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((u) => (
                <UserRow
                  key={u.userId}
                  user={u}
                  isAdmin={isAdmin}
                  onErase={
                    isAdmin &&
                    currentUserId !== null &&
                    u.userId !== currentUserId
                      ? () => setEraseTarget(u)
                      : undefined
                  }
                  erasing={erasingId === u.userId}
                />
              ))}
            </TableBody>
          </Table>
          <div
            style={{
              padding: "10px 16px",
              fontSize: "12px",
              color: TOKENS.textMuted,
              borderTop: `1px solid ${TOKENS.borderColor}`,
            }}
          >
            {filtered.length} user{filtered.length !== 1 ? "s" : ""}
            {query ? ` matching "${query}"` : " total"}
          </div>
        </div>
      )}
    </div>
  );
}
