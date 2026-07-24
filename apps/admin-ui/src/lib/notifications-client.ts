import { userManager } from "../authProvider.js";
import { API_URL, fetchWithAuth } from "./api.js";

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  read: boolean;
}

interface ListResponse {
  data: NotificationItem[];
  nextCursor: string | null;
}

export async function listNotifications(
  cursor?: string,
): Promise<ListResponse> {
  const params = new URLSearchParams({ limit: "10" });
  if (cursor) params.set("cursor", cursor);
  const res = (await fetchWithAuth(
    `${API_URL}/notifications?${params.toString()}`,
  )) as { data: NotificationItem[]; nextCursor: string | null };
  return { data: res.data, nextCursor: res.nextCursor };
}

export async function markNotificationRead(id: string): Promise<void> {
  await fetchWithAuth(`${API_URL}/notifications/${id}/read`, {
    method: "POST",
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await fetchWithAuth(`${API_URL}/notifications/mark-all-read`, {
    method: "POST",
  });
}

// ── Live socket ───────────────────────────────────────────────────────────────
// Reconnects with backoff on drop; JWT is passed as a ?token= query param since
// browsers can't set custom headers on a WebSocket handshake.

type PushHandler = (msg: {
  type: "notification" | "read";
  notification?: NotificationItem;
  notificationIds?: string[] | "all";
}) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
let currentHandler: PushHandler | null = null;
let stopped = false;

function wsUrl(token: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/notifications?token=${encodeURIComponent(token)}`;
}

async function connect(): Promise<void> {
  if (stopped) return;
  const user = await userManager.getUser();
  const token = user?.access_token;
  if (!token) {
    reconnectTimer = setTimeout(() => void connect(), reconnectDelayMs);
    return;
  }

  const ws = new WebSocket(wsUrl(token));
  socket = ws;

  ws.onopen = () => {
    reconnectDelayMs = 1_000;
  };

  ws.onmessage = (event) => {
    if (!currentHandler) return;
    try {
      // Trusted server-sent payload over our own authenticated socket — cast
      // rather than re-validate with Zod on every push message.
      const parsed = JSON.parse(
        event.data as string,
      ) as Parameters<PushHandler>[0];
      currentHandler(parsed);
    } catch {
      // ignore malformed push messages
    }
  };

  ws.onclose = () => {
    if (stopped) return;
    reconnectTimer = setTimeout(() => void connect(), reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    ws.close();
  };
}

/** Call once per app session. Returns a cleanup function. */
export function subscribeToNotifications(handler: PushHandler): () => void {
  currentHandler = handler;
  stopped = false;
  void connect();

  return () => {
    stopped = true;
    currentHandler = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}
