import React, { useEffect, useState } from "react";
import {
  Button,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TOKENS,
} from "@platform/ui";
import {
  listSystemLogs,
  type SystemLogEntry,
} from "../lib/system-logs-client.js";
import { useTranslation } from "react-i18next";
import { relativeTime } from "../lib/format.js";

export function SystemLogsPage(): React.ReactElement {
  const { t } = useTranslation();
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
        setError(err instanceof Error ? err.message : t("logs.failedToLoad")),
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
        setError(err instanceof Error ? err.message : t("logs.failedToLoad")),
      )
      .finally(() => setLoadingMore(false));
  }

  return (
    <div>
      <div style={{ marginBottom: "24px" }}>
        <h2 className="page-title">{t("logs.title")}</h2>
        <p className="page-subtitle">{t("logs.subtitle")}</p>
      </div>

      {loading && (
        <div className="loading-center">
          <div className="spinner" />
          <span className="loader-text">{t("logs.loading")}</span>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && logs.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">✅</div>
          <div className="empty-state-title">{t("logs.noErrors")}</div>
          <div className="empty-state-subtitle">{t("logs.noErrorsDesc")}</div>
        </div>
      )}

      {!loading && !error && logs.length > 0 && (
        <div
          className="data-panel"
          style={{ overflowX: "auto", overflowY: "hidden" }}
        >
          <Table scroll={false}>
            <TableHeader>
              <TableRow>
                {[
                  "",
                  t("logs.columnTitle"),
                  t("logs.columnDetails"),
                  t("logs.columnOccurred"),
                  "ID",
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
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell style={{ padding: "12px 16px", width: "1%" }}>
                    <div
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: TOKENS.danger,
                      }}
                      title={t("logs.urgentTitle")}
                    />
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "14px",
                      fontWeight: 600,
                      color: TOKENS.textPrimary,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.title}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: TOKENS.textSecondary,
                      wordBreak: "break-word",
                      minWidth: "320px",
                    }}
                  >
                    {log.body}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      color: TOKENS.textSecondary,
                      whiteSpace: "nowrap",
                    }}
                    title={new Date(log.createdAt).toLocaleString()}
                  >
                    {relativeTime(log.createdAt)}
                  </TableCell>
                  <TableCell
                    style={{
                      padding: "12px 16px",
                      fontSize: "11px",
                      color: TOKENS.textMuted,
                      fontFamily: "monospace",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {log.id}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div
            style={{
              padding: "10px 16px",
              fontSize: "12px",
              color: TOKENS.textMuted,
              borderTop: `1px solid ${TOKENS.borderColor}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>{t("logs.entryCount", { count: logs.length })}</span>
            {cursor && (
              <Button
                type="button"
                variant="secondary"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? t("logs.loadingMore") : t("logs.loadMore")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
