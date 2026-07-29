import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  subscribeToNotifications,
  type NotificationItem,
} from "../lib/notifications-client.js";
import { relativeTime } from "../lib/format.js";

const BELL_ICON = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth="2"
    stroke="currentColor"
    width="20"
    height="20"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
    />
  </svg>
);

export function NotificationBell(): React.ReactElement {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [panelHeight, setPanelHeight] = useState(420);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ y: number; height: number } | null>(null);

  const MIN_PANEL_HEIGHT = 240;
  const MAX_PANEL_HEIGHT = 720;

  const unreadCount = items.filter((n) => !n.read).length;

  useEffect(() => {
    void listNotifications().then((res) => {
      setItems(res.data);
      setNextCursor(res.nextCursor);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToNotifications((msg) => {
      if (msg.type === "notification" && msg.notification) {
        const incoming = msg.notification;
        setItems((prev) => {
          if (prev.some((n) => n.id === incoming.id)) return prev;
          return [{ ...incoming, read: false }, ...prev];
        });
      } else if (msg.type === "read") {
        setItems((prev) =>
          prev.map((n) =>
            msg.notificationIds === "all" ||
            (Array.isArray(msg.notificationIds) &&
              msg.notificationIds.includes(n.id))
              ? { ...n, read: true }
              : n,
          ),
        );
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    function close(e: MouseEvent): void {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      )
        setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartRef.current = { y: e.clientY, height: panelHeight };

      function onMove(moveEvent: MouseEvent): void {
        if (!resizeStartRef.current) return;
        const delta = moveEvent.clientY - resizeStartRef.current.y;
        const next = Math.min(
          MAX_PANEL_HEIGHT,
          Math.max(MIN_PANEL_HEIGHT, resizeStartRef.current.height + delta),
        );
        setPanelHeight(next);
      }
      function onUp(): void {
        resizeStartRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [panelHeight],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await listNotifications(nextCursor);
      setItems((prev) => [...prev, ...res.data]);
      setNextCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  async function handleMarkAllRead(): Promise<void> {
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    await markAllNotificationsRead();
  }

  async function handleClick(n: NotificationItem): Promise<void> {
    setOpen(false);
    if (!n.read) {
      setItems((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
      );
      await markNotificationRead(n.id);
    }
    if (n.link) navigate(n.link);
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "32px",
          height: "32px",
          borderRadius: "8px",
          border: "none",
          background: "transparent",
          color: "var(--text-secondary)",
          cursor: "pointer",
          transition: "background .15s, color .15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "var(--bg-tertiary)";
          (e.currentTarget as HTMLButtonElement).style.color =
            "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background =
            "transparent";
          (e.currentTarget as HTMLButtonElement).style.color =
            "var(--text-secondary)";
        }}
      >
        {BELL_ICON}
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: "-2px",
              right: "-2px",
              minWidth: "16px",
              height: "16px",
              padding: "0 3px",
              borderRadius: "8px",
              background: "var(--danger)",
              color: "#fff",
              fontSize: "10px",
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 10px)",
            right: 0,
            width: "340px",
            height: `${panelHeight}px`,
            display: "flex",
            flexDirection: "column",
            background: "var(--bg-card)",
            backdropFilter: "blur(8px)",
            border: "1px solid var(--border-color)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 200,
            overflow: "hidden",
            animation: "popup-in .12s ease",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1px solid var(--border-color)",
            }}
          >
            <span style={{ fontSize: "13px", fontWeight: 600 }}>
              Notifications
            </span>
            <button
              onClick={() => void handleMarkAllRead()}
              style={{
                fontSize: "12px",
                color: "var(--accent-primary)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Mark all as read
            </button>
          </div>

          <div style={{ overflowY: "auto", flex: 1, paddingBottom: "8px" }}>
            {items.length === 0 && (
              <div
                style={{
                  padding: "24px 16px",
                  textAlign: "center",
                  fontSize: "13px",
                  color: "var(--text-muted)",
                }}
              >
                No notifications yet
              </div>
            )}
            {items.map((n) => {
              const urgent = n.type === "system.error";
              return (
                <button
                  key={n.id}
                  onClick={() => void handleClick(n)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 16px",
                    border: "none",
                    borderBottom: "1px solid var(--border-color)",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      fontSize: "13px",
                      fontWeight: 600,
                      color: urgent ? "var(--danger)" : "var(--text-primary)",
                    }}
                  >
                    {!n.read && (
                      <span
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: urgent
                            ? "var(--danger)"
                            : "var(--accent-primary)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    {n.title}
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "var(--text-muted)",
                      marginTop: "2px",
                    }}
                  >
                    {n.body}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      marginTop: "4px",
                    }}
                  >
                    {relativeTime(n.createdAt)}
                  </div>
                </button>
              );
            })}
          </div>

          {nextCursor && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              style={{
                padding: "10px",
                fontSize: "12px",
                color: "var(--accent-primary)",
                background: "none",
                border: "none",
                borderTop: "1px solid var(--border-color)",
                cursor: loadingMore ? "default" : "pointer",
              }}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}

          <div
            onMouseDown={handleResizeStart}
            style={{
              flexShrink: 0,
              height: "10px",
              cursor: "ns-resize",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderTop: "1px solid var(--border-color)",
              background: "var(--bg-tertiary)",
            }}
            title="Drag to resize"
          >
            <div
              style={{
                width: "32px",
                height: "3px",
                borderRadius: "2px",
                background: "var(--text-muted)",
                opacity: 0.5,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
