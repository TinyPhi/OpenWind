import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { eq, and } from "drizzle-orm";
import {
  verifyJwt,
  extractAuthContext,
  lookupTenantIdByOrgId,
} from "@platform/auth";
import { getRedis, NOTIFICATION_PUSH_CHANNEL } from "@platform/redis";
import { logger } from "@platform/logger";
import { env } from "@platform/config";
import { entityInstances, withTenantContext } from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { hasEntityAccess } from "../lib/entity-access.js";

const WS_PATH = "/ws/notifications";

// M2 (PR #376 review): a user legitimately viewing several tickets at once
// (e.g. a multi-tab agent workflow) fits well under this; a flood beyond it
// is either a broken client or abuse, not a real use case.
const MAX_ROOMS_PER_CONNECTION = 10;

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
  const key = connectionKey(tenantId, userId);
  const set = connections.get(key);
  if (!set) {
    logger.warn(
      { tenantId, userId, openKeys: Array.from(connections.keys()) },
      "Notification websocket: push received but no matching open connection",
    );
    return;
  }
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws === exclude) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Ticket-room registry (docs/specs/ticket-live-updates.md) — parallel to, and
// independent of, the per-user `connections` map above. Keyed by
// `${tenantId}:${instanceId}` together, never `instanceId` alone, mirroring
// the same cross-tenant-leak-risk reasoning as connectionKey above (spec §V).
function roomKey(tenantId: string, instanceId: string): string {
  return `${tenantId}:${instanceId}`;
}

const rooms = new Map<string, Set<WebSocket>>();
// Reverse index so a single `close`/`error` handler can remove a connection
// from every room it joined without iterating the entire `rooms` map.
const wsRooms = new Map<WebSocket, Set<string>>();
// Per-connection identity, needed by sendAccessRequestToRoom (H1 fix, PR #376
// review) to decide per-recipient whether a room push carries the full
// payload or a stripped one — access-request identities are more sensitive
// than a comment room push and must not go to every room member uniformly.
const wsMeta = new Map<WebSocket, { userId: string; roles: string[] }>();

function addToRoom(tenantId: string, instanceId: string, ws: WebSocket): void {
  const key = roomKey(tenantId, instanceId);
  const set = rooms.get(key) ?? new Set<WebSocket>();
  set.add(ws);
  rooms.set(key, set);
  const wsSet = wsRooms.get(ws) ?? new Set<string>();
  wsSet.add(key);
  wsRooms.set(ws, wsSet);
}

function removeFromRoom(
  tenantId: string,
  instanceId: string,
  ws: WebSocket,
): void {
  const key = roomKey(tenantId, instanceId);
  const set = rooms.get(key);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(key);
  }
  wsRooms.get(ws)?.delete(key);
}

function removeFromAllRooms(ws: WebSocket): void {
  const keys = wsRooms.get(ws);
  if (!keys) return;
  for (const key of keys) {
    const set = rooms.get(key);
    if (!set) continue;
    set.delete(ws);
    if (set.size === 0) rooms.delete(key);
  }
  wsRooms.delete(ws);
}

function sendToRoom(
  tenantId: string,
  instanceId: string,
  message: unknown,
): void {
  const key = roomKey(tenantId, instanceId);
  const set = rooms.get(key);
  if (!set) return;
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

interface AccessRequestRoomMessage {
  type: "access_request.created" | "access_request.updated";
  instanceId: string;
  request: {
    id: string;
    requestedBy: string;
    status: string;
    resolvedBy?: string;
    resolvedAt?: string;
    createdAt: string;
  };
}

/**
 * H1 fix (PR #376 review): the same room a comment.created push reaches
 * every viewer of, including read-only ones, must NOT uniformly receive
 * access_request.created/updated pushes — GET /entities/:id/access-requests
 * (list-access-requests.ts) restricts that data to owner/admin/agent/
 * workflow-admin, and the room push must match. Full payload (with
 * requestedBy/resolvedBy) goes only to connections passing that same check;
 * the requester's own connection gets a reduced payload with no other
 * identity in it; every other room member gets nothing for this event.
 */
async function sendAccessRequestToRoom(
  tenantId: string,
  instanceId: string,
  message: AccessRequestRoomMessage,
): Promise<void> {
  const key = roomKey(tenantId, instanceId);
  const set = rooms.get(key);
  if (!set || set.size === 0) return;

  const [instance] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        createdBy: entityInstances.createdBy,
        assignedTo: entityInstances.assignedTo,
        workflowId: entityInstances.workflowId,
      })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.id, instanceId),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .limit(1),
  );
  if (!instance) return;

  const workflow = instance.workflowId
    ? await withTenantContext(tenantId, (tx) =>
        getWorkflow(tx, tenantId, instance.workflowId as string, {
          userId: "",
          isGlobalAdmin: false,
        }),
      ).catch(() => null)
    : null;

  const reducedMessage: AccessRequestRoomMessage = {
    ...message,
    request: {
      id: message.request.id,
      status: message.request.status,
      requestedBy: message.request.requestedBy,
      createdAt: message.request.createdAt,
    },
  };
  const fullData = JSON.stringify(message);
  const reducedData = JSON.stringify(reducedMessage);

  for (const ws of set) {
    if (ws.readyState !== ws.OPEN) continue;
    const meta = wsMeta.get(ws);
    if (!meta) continue;
    const isOwner =
      instance.createdBy === meta.userId || instance.assignedTo === meta.userId;
    const isAdminOrAgent =
      meta.roles.includes("admin") || meta.roles.includes("agent");
    const isRecordWorkflowAdmin = workflow
      ? isWorkflowAdmin(meta.userId, workflow)
      : false;
    if (isOwner || isAdminOrAgent || isRecordWorkflowAdmin) {
      ws.send(fullData);
    } else if (meta.userId === message.request.requestedBy) {
      ws.send(reducedData);
    }
    // Neither privileged nor the requester: no push. Matches the REST
    // endpoint's 404-not-403 posture — a bystander learns nothing.
  }
}

/**
 * Same read-access gate as GET/list-events/list-children on this record
 * (apps/api/src/lib/entity-access.ts) — a user must not be able to join a
 * ticket's live-update room for a ticket they can't read.
 */
async function checkTicketRoomAccess(
  tenantId: string,
  instanceId: string,
  userId: string,
  roles: string[],
): Promise<boolean> {
  try {
    const [instance] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          createdBy: entityInstances.createdBy,
          assignedTo: entityInstances.assignedTo,
          fields: entityInstances.fields,
          workflowId: entityInstances.workflowId,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, instanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1),
    );
    if (!instance) return false;
    return await withTenantContext(tenantId, (tx) =>
      hasEntityAccess(tx, tenantId, instance, userId, roles),
    );
  } catch (err) {
    logger.error(
      { err, tenantId, instanceId },
      "Notification websocket: ticket-room access check failed",
    );
    return false;
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
      const parsed = JSON.parse(message) as {
        kind?: "room" | "user";
        tenantId: string;
        userId?: string;
        instanceId?: string;
        notification?: unknown;
        message?: unknown;
      };
      // `kind` is absent on messages published before this field existed
      // (and still absent from apps/worker/src/alert-worker.ts's publishes,
      // which this dispatch must keep serving unchanged) — treat a missing
      // kind as "user", not as an error.
      if (parsed.kind === "room") {
        if (!parsed.instanceId) return;
        const roomMessage = parsed.message as { type?: string } | undefined;
        if (
          roomMessage?.type === "access_request.created" ||
          roomMessage?.type === "access_request.updated"
        ) {
          void sendAccessRequestToRoom(
            parsed.tenantId,
            parsed.instanceId,
            parsed.message as AccessRequestRoomMessage,
          ).catch((err: unknown) => {
            logger.error(
              { err, tenantId: parsed.tenantId, instanceId: parsed.instanceId },
              "Notification websocket: access-request room push failed",
            );
          });
          return;
        }
        sendToRoom(parsed.tenantId, parsed.instanceId, parsed.message);
        return;
      }
      if (!parsed.userId) return;
      sendToConnections(parsed.tenantId, parsed.userId, {
        type: "notification",
        notification: parsed.notification,
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

      // Mirror requireAuth()'s org -> tenant resolution (packages/auth/src/middleware.ts):
      // extractAuthContext's tenantId is the raw Zitadel org id in production, not the
      // internal tenants.id UUID that notification_recipients.tenant_id actually stores.
      // Without this, every connection here registers under the wrong key and
      // sendToConnections silently finds nothing to send to.
      let tenantId = auth.tenantId;
      if (env.NODE_ENV === "production") {
        const mappedTenantId = auth.orgId
          ? await lookupTenantIdByOrgId(auth.orgId)
          : null;
        if (!mappedTenantId) {
          socket.destroy();
          return;
        }
        tenantId = mappedTenantId;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        addConnection(tenantId, auth.userId, ws);
        wsMeta.set(ws, { userId: auth.userId, roles: auth.roles });
        logger.info(
          { tenantId, userId: auth.userId },
          "Notification websocket: connection registered",
        );

        ws.on("message", (data: Buffer | string) => {
          void (async () => {
            let parsed: { type?: string; instanceId?: string };
            try {
              parsed = JSON.parse(data.toString()) as {
                type?: string;
                instanceId?: string;
              };
            } catch {
              return;
            }
            if (!parsed.instanceId) return;

            if (parsed.type === "subscribe_ticket") {
              // M2 (PR #376 review): cap rooms per connection so a flood of
              // subscribe_ticket frames (buggy client reconnect loop or a
              // malicious authenticated user) can't grow `wsRooms` and fire
              // unbounded DB access checks.
              const joined = wsRooms.get(ws)?.size ?? 0;
              if (joined >= MAX_ROOMS_PER_CONNECTION) {
                logger.warn(
                  { tenantId, userId: auth.userId, joined },
                  "Notification websocket: subscribe_ticket room cap exceeded",
                );
                return;
              }
              const allowed = await checkTicketRoomAccess(
                tenantId,
                parsed.instanceId,
                auth.userId,
                auth.roles,
              );
              // Silently not joined on failure — mirrors the platform's
              // "404 not 403" convention (never confirm/deny the instance's
              // existence to a caller without read access to it). On
              // success, echo a confirmation so callers (including tests,
              // PR #376 review L2) have a deterministic signal that the room
              // join has actually completed instead of racing a fixed delay.
              if (allowed) {
                addToRoom(tenantId, parsed.instanceId, ws);
                if (ws.readyState === ws.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "subscribed_ticket",
                      instanceId: parsed.instanceId,
                    }),
                  );
                }
              }
              return;
            }
            if (parsed.type === "unsubscribe_ticket") {
              removeFromRoom(tenantId, parsed.instanceId, ws);
            }
          })().catch((err: unknown) => {
            logger.error(
              { err, tenantId, userId: auth.userId },
              "Notification websocket: message handling failed",
            );
          });
        });
        ws.on("close", () => {
          removeConnection(tenantId, auth.userId, ws);
          removeFromAllRooms(ws);
          wsMeta.delete(ws);
        });
        ws.on("error", () => {
          removeConnection(tenantId, auth.userId, ws);
          removeFromAllRooms(ws);
          wsMeta.delete(ws);
        });
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
  rooms.clear();
  wsRooms.clear();
  wsMeta.clear();
}
