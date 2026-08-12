import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket as WsClient } from "ws";

// ── Boundary mocks (matches the existing convention in add-comment.test.ts /
// resolve-access-request.test.ts / notification-worker.test.ts — mock
// @platform/db and @platform/auth at the module boundary, not the real DB) ──

let claims: { sub: string; roles?: string[]; orgId?: string } | null = {
  sub: "u-1",
};
vi.mock("@platform/auth", () => ({
  verifyJwt: (_token: string) => Promise.resolve(claims),
  extractAuthContext: (c: { sub: string; roles?: string[] }) => ({
    userId: c.sub,
    tenantId: "t-1",
    roles: c.roles ?? ["user"],
    orgId: undefined,
  }),
  lookupTenantIdByOrgId: vi.fn(),
}));

vi.mock("@platform/config", () => ({
  env: { NODE_ENV: "test" },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const entityInstancesTable = { id: "entity_instances.id" };
vi.mock("@platform/db", () => ({
  entityInstances: entityInstancesTable,
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  createdBy: "u-owner",
                  assignedTo: null,
                  fields: {},
                  workflowId: null,
                },
              ]),
          }),
        }),
      }),
    }),
}));

// hasEntityAccess is the actual read-access gate — stub it so each test
// controls whether the connecting user is allowed into the room, independent
// of the entityInstances row shape above.
let accessGranted = true;
vi.mock("../lib/entity-access.js", () => ({
  hasEntityAccess: () => Promise.resolve(accessGranted),
}));

let redisSubscribeHandler: ((channel: string, message: string) => void) | null =
  null;
const mockRedis = {
  duplicate: () => mockRedis,
  subscribe: vi.fn().mockResolvedValue(undefined),
  publish: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  on: (_event: string, handler: (channel: string, message: string) => void) => {
    redisSubscribeHandler = handler;
  },
};
vi.mock("@platform/redis", () => ({
  getRedis: () => mockRedis,
  NOTIFICATION_PUSH_CHANNEL: "notification:push",
}));

const { attachNotificationWebSocket, stopNotificationWebSocket } =
  await import("./notifications.js");

let server: Server;
let port: number;

async function startServer(): Promise<void> {
  server = createServer();
  attachNotificationWebSocket(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
}

function connect(): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(
      `ws://127.0.0.1:${port}/ws/notifications?token=fake`,
    );
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(ws: WsClient): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data: Buffer) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("notifications websocket — ticket rooms (docs/specs/ticket-live-updates.md)", () => {
  beforeEach(async () => {
    accessGranted = true;
    claims = { sub: "u-1" };
    redisSubscribeHandler = null;
    await startServer();
  });

  afterEach(async () => {
    await stopNotificationWebSocket();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers a room push to a subscribed connection with read access", async () => {
    const ws = await connect();
    const subscribedPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "subscribe_ticket", instanceId: "i-1" }));
    // Wait for the server's subscribed_ticket confirmation rather than a
    // fixed delay (PR #376 review L2) — deterministic under CI load.
    await subscribedPromise;

    const messagePromise = waitForMessage(ws);
    redisSubscribeHandler?.(
      "notification:push",
      JSON.stringify({
        kind: "room",
        tenantId: "t-1",
        instanceId: "i-1",
        message: { type: "comment.created", instanceId: "i-1" },
      }),
    );

    const received = (await messagePromise) as { type: string };
    expect(received.type).toBe("comment.created");
    ws.close();
  });

  it("never joins the room when the caller lacks read access to the instance", async () => {
    accessGranted = false;
    const ws = await connect();
    ws.send(JSON.stringify({ type: "subscribe_ticket", instanceId: "i-2" }));
    await new Promise((r) => setTimeout(r, 20));

    let received: unknown = null;
    ws.once("message", (data: Buffer) => {
      received = JSON.parse(data.toString());
    });
    redisSubscribeHandler?.(
      "notification:push",
      JSON.stringify({
        kind: "room",
        tenantId: "t-1",
        instanceId: "i-2",
        message: { type: "comment.created", instanceId: "i-2" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toBeNull();
    ws.close();
  });

  it("never cross-delivers a room push to a different tenant sharing the same instanceId", async () => {
    const ws = await connect(); // registers as tenantId "t-1" per the auth mock
    const subscribedPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "subscribe_ticket", instanceId: "i-3" }));
    await subscribedPromise;

    let received: unknown = null;
    ws.once("message", (data: Buffer) => {
      received = JSON.parse(data.toString());
    });
    // Same instanceId, a different tenant's push — must not reach this
    // connection even though the room key would collide on instanceId alone.
    redisSubscribeHandler?.(
      "notification:push",
      JSON.stringify({
        kind: "room",
        tenantId: "t-OTHER",
        instanceId: "i-3",
        message: { type: "comment.created", instanceId: "i-3" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toBeNull();
    ws.close();
  });

  it("stops delivering room pushes after unsubscribe_ticket", async () => {
    const ws = await connect();
    const subscribedPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "subscribe_ticket", instanceId: "i-4" }));
    await subscribedPromise;
    ws.send(JSON.stringify({ type: "unsubscribe_ticket", instanceId: "i-4" }));
    // unsubscribe_ticket has no confirmation frame — it's a fire-and-forget
    // map removal with no async work, so a short fixed delay here is enough
    // to let the synchronous handler run before the push is simulated.
    await new Promise((r) => setTimeout(r, 20));

    let received: unknown = null;
    ws.once("message", (data: Buffer) => {
      received = JSON.parse(data.toString());
    });
    redisSubscribeHandler?.(
      "notification:push",
      JSON.stringify({
        kind: "room",
        tenantId: "t-1",
        instanceId: "i-4",
        message: { type: "comment.created", instanceId: "i-4" },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(received).toBeNull();
    ws.close();
  });

  it("stops delivering room pushes after the connection closes, without an explicit unsubscribe", async () => {
    const ws = await connect();
    const subscribedPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "subscribe_ticket", instanceId: "i-5" }));
    await subscribedPromise;
    ws.close();
    await new Promise((r) => setTimeout(r, 20));

    // Publishing after close must not throw even though the room no longer
    // has any live connection — this asserts via absence of an unhandled
    // rejection/throw, since there's no socket left to assert a message on.
    expect(() =>
      redisSubscribeHandler?.(
        "notification:push",
        JSON.stringify({
          kind: "room",
          tenantId: "t-1",
          instanceId: "i-5",
          message: { type: "comment.created", instanceId: "i-5" },
        }),
      ),
    ).not.toThrow();
  });
});
