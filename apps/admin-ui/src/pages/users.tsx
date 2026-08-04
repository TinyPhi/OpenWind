import React, { useEffect, useState } from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@platform/ui";
import { fetchWithAuth, API_URL } from "../lib/api.js";
import { userManager } from "../authProvider.js";

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

function initials(name: string): string {
  return name
    .split(" ")
    .slice(0, 2)
    .map((p) => p.charAt(0))
    .join("")
    .toUpperCase();
}

const AVATAR_COLORS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#ef4444",
  "#14b8a6",
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length] ?? "#6366f1";
}

export function UsersPage(): React.ReactElement {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const isAdmin = roles.includes("admin");

  useEffect(() => {
    void userManager.getUser().then((u) => {
      setRoles(
        getRolesFromProfile(u?.profile as Record<string, unknown> | undefined),
      );
    });
  }, []);

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
              {filtered.map((u) => {
                const color = avatarColor(u.userId);
                return (
                  <TableRow
                    key={u.userId}
                    onMouseEnter={(e) => {
                      (
                        e.currentTarget as HTMLTableRowElement
                      ).style.background =
                        "var(--bg-tertiary, hsl(222, 15%, 16%))";
                    }}
                    onMouseLeave={(e) => {
                      (
                        e.currentTarget as HTMLTableRowElement
                      ).style.background = "";
                    }}
                  >
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
                          {initials(u.displayName)}
                        </div>
                        <span
                          style={{
                            fontSize: "14px",
                            fontWeight: 500,
                            color: "var(--text-primary)",
                          }}
                        >
                          {u.displayName}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell
                      style={{
                        padding: "12px 16px",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {u.loginName}
                    </TableCell>
                    <TableCell
                      style={{
                        padding: "12px 16px",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {u.email}
                    </TableCell>
                    <TableCell style={{ padding: "12px 16px" }}>
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          flexWrap: "wrap",
                        }}
                      >
                        {(u.roles ?? []).length === 0 ? (
                          <span
                            style={{
                              fontSize: "12px",
                              color: "var(--text-muted)",
                            }}
                          >
                            —
                          </span>
                        ) : (
                          (u.roles ?? []).map((role) => (
                            <span
                              key={role}
                              style={{
                                fontSize: "11px",
                                fontWeight: 600,
                                padding: "2px 8px",
                                borderRadius: "999px",
                                background:
                                  "var(--bg-tertiary, hsl(222, 15%, 16%))",
                                color: "var(--text-secondary)",
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
                        color: "var(--text-muted)",
                        fontFamily: "monospace",
                      }}
                    >
                      {u.userId}
                    </TableCell>
                    {isAdmin && (
                      <TableCell
                        style={{ padding: "12px 16px", textAlign: "right" }}
                      >
                        <a
                          href={zitadelUserUrl(u.userId)}
                          target="_blank"
                          rel="noreferrer"
                          title="Open in Zitadel"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: "28px",
                            height: "28px",
                            borderRadius: "6px",
                            color: "var(--text-muted)",
                            textDecoration: "none",
                            transition: "background 0.15s, color 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            const el = e.currentTarget as HTMLAnchorElement;
                            el.style.background =
                              "var(--bg-tertiary, hsl(222, 15%, 16%))";
                            el.style.color = "var(--accent, #6366f1)";
                          }}
                          onMouseLeave={(e) => {
                            const el = e.currentTarget as HTMLAnchorElement;
                            el.style.background = "";
                            el.style.color = "var(--text-muted)";
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
              })}
            </TableBody>
          </Table>
          <div
            style={{
              padding: "10px 16px",
              fontSize: "12px",
              color: "var(--text-muted)",
              borderTop: "1px solid var(--border)",
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
