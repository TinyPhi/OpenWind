import React, { useEffect, useState } from "react";
import {
  listSystemLogs,
  type SystemLogEntry,
} from "../lib/system-logs-client.js";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SystemLogsPage(): React.ReactElement {
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listSystemLogs()
      .then((res) => {
        setLogs(res.data);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof Error ? err.message : "Failed to load system logs",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  function loadMore(): void {
    if (!cursor) return;
    setLoadingMore(true);
    listSystemLogs(cursor)
      .then((res) => {
        setLogs((prev) => [...prev, ...res.data]);
        setCursor(res.nextCursor);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof Error ? err.message : "Failed to load system logs",
        ),
      )
      .finally(() => setLoadingMore(false));
  }

  return (
    <div>
      <div style={{ marginBottom: "24px" }}>
        <h2 className="page-title">System Logs</h2>
        <p className="page-subtitle">
          Permanent delivery failures and other system-level errors reported by
          the platform.
        </p>
      </div>

      {loading && (
        <div className="loading-center">
          <div className="spinner" />
          <span className="loader-text">Loading system logs…</span>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && logs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">✅</div>
          <div className="empty-state-title">No system errors</div>
          <div className="empty-state-subtitle">
            Nothing to report — this list stays empty as long as the platform
            has no unrecovered failures to surface.
          </div>
        </div>
      )}

      {!loading && !error && logs.length > 0 && (
        <div
          className="data-panel"
          style={{ overflowX: "auto", overflowY: "hidden" }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["", "Title", "Details", "Occurred", "ID"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "10px 16px",
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      background: "var(--surface-secondary, var(--bg-subtle))",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr
                  key={log.id}
                  style={{
                    borderBottom:
                      i < logs.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                >
                  <td style={{ padding: "12px 16px", width: "1%" }}>
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: "#ef4444",
                      }}
                      title="Urgent — system error"
                    />
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      fontSize: "14px",
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.title}
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: "var(--text-secondary)",
                      wordBreak: "break-word",
                      minWidth: "320px",
                    }}
                  >
                    {log.body}
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: "var(--text-secondary)",
                      whiteSpace: "nowrap",
                    }}
                    title={new Date(log.createdAt).toLocaleString()}
                  >
                    {relativeTime(log.createdAt)}
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      fontFamily: "monospace",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div
            style={{
              padding: "10px 16px",
              fontSize: "12px",
              color: "var(--text-muted)",
              borderTop: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {logs.length} entr{logs.length !== 1 ? "ies" : "y"}
            </span>
            {cursor && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
