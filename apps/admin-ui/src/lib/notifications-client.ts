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

export async function getUnreadCount(): Promise<number> {
  const res = (await fetchWithAuth(
    `${API_URL}/notifications/unread-count`,
  )) as {
    data: { count: number };
  };
  return res.data.count;
}

export async function markNotificationRead(id: string): Promise<void> {
  await fetchWithAuth(
    `${API_URL}/notifications/${encodeURIComponent(id)}/read`,
    {
      method: "POST",
    },
  );
}

export async function markAllNotificationsRead(): Promise<void> {
  await fetchWithAuth(`${API_URL}/notifications/mark-all-read`, {
    method: "POST",
  });
}

// ── Live socket ───────────────────────────────────────────────────────────────
// Reconnects with backoff on drop; JWT is passed as a ?token= query param since
// browsers can't set custom headers on a WebSocket handshake. The bell (a
// persistent, always-mounted listener) and any number of ticket detail pages
// (transient, mount/unmount-driven room subscribers) share this one socket —
// see docs/specs/ticket-live-updates.md — rather than each opening their own.

export interface TicketRoomComment {
  id: string;
  body: string;
  authorId: string;
  createdAt: string;
}

export interface TicketRoomAccessRequest {
  id: string;
  requestedBy: string;
  status: "pending" | "approved" | "rejected";
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

export type PushMessage =
  | { type: "notification"; notification: NotificationItem }
  | { type: "read"; notificationIds: string[] | "all" }
  | { type: "comment.created"; instanceId: string; comment: TicketRoomComment }
  | {
      type: "access_request.created" | "access_request.updated";
      instanceId: string;
      request: TicketRoomAccessRequest;
    };

type PushHandler = (msg: PushMessage) => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const listeners = new Set<PushHandler>();
// Ticket rooms the app currently wants subscribed — resent on every
// (re)connect (R8: a dropped/reconnected socket must not silently leave a
// still-open ticket page without live updates).
const activeTicketRooms = new Set<string>();
let stopped = true;

function wsUrl(token: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/notifications?token=${encodeURIComponent(token)}`;
}

function sendRoomMessage(
  type: "subscribe_ticket" | "unsubscribe_ticket",
  instanceId: string,
): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, instanceId }));
  }
  // If not currently open, `activeTicketRooms` (already updated by the
  // caller before this runs) is replayed on the next `onopen` instead.
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
    for (const instanceId of activeTicketRooms) {
      sendRoomMessage("subscribe_ticket", instanceId);
    }
  };

  ws.onmessage = (event) => {
    if (listeners.size === 0) return;
    try {
      // Trusted server-sent payload over our own authenticated socket — cast
      // rather than re-validate with Zod on every push message.
      const parsed = JSON.parse(event.data as string) as PushMessage;
      for (const listener of listeners) listener(parsed);
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

function ensureConnected(): void {
  stopped = false;
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  void connect();
}

function disconnectIfIdle(): void {
  if (listeners.size > 0 || activeTicketRooms.size > 0) return;
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}

/** Call once per app session (the notification bell). Returns a cleanup function. */
export function subscribeToNotifications(handler: PushHandler): () => void {
  listeners.add(handler);
  ensureConnected();

  return () => {
    listeners.delete(handler);
    disconnectIfIdle();
  };
}

/**
 * Joins a ticket's live-update room for the lifetime of the caller (typically
 * a ticket detail page). `handler` receives every push on the shared socket,
 * same as subscribeToNotifications — filter on `msg.type` /
 * `msg.instanceId` for the ones this room cares about. Returns a cleanup
 * function that unsubscribes the room and removes the handler.
 */
export function subscribeToTicketRoom(
  instanceId: string,
  handler: PushHandler,
): () => void {
  listeners.add(handler);
  activeTicketRooms.add(instanceId);
  ensureConnected();
  sendRoomMessage("subscribe_ticket", instanceId);

  return () => {
    listeners.delete(handler);
    activeTicketRooms.delete(instanceId);
    sendRoomMessage("unsubscribe_ticket", instanceId);
    disconnectIfIdle();
  };
}
