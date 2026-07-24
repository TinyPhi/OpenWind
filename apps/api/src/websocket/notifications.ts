import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { verifyJwt, extractAuthContext } from "@platform/auth";
import { getRedis, NOTIFICATION_PUSH_CHANNEL } from "@platform/redis";
import { logger } from "@platform/logger";

const WS_PATH = "/ws/notifications";

// Keyed by (tenantId, userId) together, never userId alone — the tenant is
// already known from the JWT at handshake time, so this costs nothing extra
// and removes any dependence on "a user only ever belongs to one tenant"
// continuing to hold (docs/specs/in-app-notification-hub.md §V).
function connectionKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

const connections = new Map<string, Set<WebSocket>>();

function addConnection(tenantId: string, userId: string, ws: WebSocket): void {
  const key = connectionKey(tenantId, userId);
  const set = connections.get(key) ?? new Set<WebSocket>();
  set.add(ws);
  connections.set(key, set);
}

function removeConnection(
  tenantId: string,
  userId: string,
  ws: WebSocket,
): void {
  const key = connectionKey(tenantId, userId);
  const set = connections.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(key);
}

function sendToConnections(
  tenantId: string,
  userId: string,
  message: unknown,
  exclude?: WebSocket,
): void {
  const set = connections.get(connectionKey(tenantId, userId));
  if (!set) return;
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws === exclude) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

let subscriber: ReturnType<typeof getRedis> | null = null;

/**
 * Subscribes to the push channel apps/worker's notification worker publishes
 * on — the worker runs in a separate process and can't reach this process's
 * in-memory connection map directly. A dedicated connection is required:
 * ioredis clients in subscribe mode can't run other commands.
 */
function startPushSubscriber(): void {
  if (subscriber) return;
  subscriber = getRedis().duplicate();
  subscriber.subscribe(NOTIFICATION_PUSH_CHANNEL).catch((err: unknown) => {
    logger.error({ err }, "Notification websocket: failed to subscribe");
  });
  subscriber.on("message", (_channel: string, message: string) => {
    try {
      const { tenantId, userId, notification } = JSON.parse(message) as {
        tenantId: string;
        userId: string;
        notification: unknown;
      };
      sendToConnections(tenantId, userId, {
        type: "notification",
        notification,
      });
    } catch (err) {
      logger.error({ err }, "Notification websocket: bad push message");
    }
  });
}

async function stopPushSubscriber(): Promise<void> {
  if (subscriber) {
    await subscriber.quit();
    subscriber = null;
  }
}

/** Called by the mark-read route so a user's other open tabs update live. */
export function broadcastReadState(
  tenantId: string,
  userId: string,
  notificationIds: string[] | "all",
): void {
  sendToConnections(tenantId, userId, {
    type: "read",
    notificationIds,
  });
}

function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "", "http://internal");
  return url.searchParams.get("token");
}

// Structural type covering only what's used here — avoids depending on the
// exact Server<...> generic @hono/node-server's serve() returns (which
// varies between plain http.Server and Http2Server).
interface UpgradeCapableServer {
  on(
    event: "upgrade",
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void;
}

export function attachNotificationWebSocket(
  server: UpgradeCapableServer,
): void {
  const wss = new WebSocketServer({ noServer: true });
  startPushSubscriber();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://internal");
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    void (async () => {
      const token = extractToken(req);
      if (!token) {
        socket.destroy();
        return;
      }

      const claims = await verifyJwt(token);
      const auth = claims ? extractAuthContext(claims) : null;
      if (!auth) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        addConnection(auth.tenantId, auth.userId, ws);
        ws.on("close", () => removeConnection(auth.tenantId, auth.userId, ws));
        ws.on("error", () => removeConnection(auth.tenantId, auth.userId, ws));
      });
    })().catch((err: unknown) => {
      logger.error({ err }, "Notification websocket: upgrade failed");
      socket.destroy();
    });
  });
}

export async function stopNotificationWebSocket(): Promise<void> {
  await stopPushSubscriber();
  connections.clear();
}
