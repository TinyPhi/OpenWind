import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "@platform/logger";
import { connection as queuesConnection } from "./queues.js";
import { connection as automationConnection } from "./automation-worker.js";

const PORT = 3002;

// Checks the two independent Redis connections the worker actually depends
// on — queues.ts's shared connection (producers + 5 of 6 job processors) and
// automation-worker.ts's own connection (constructed separately because
// BullMQ Worker connections need maxRetriesPerRequest: null). They point at
// the same env.REDIS_URL and degrade together in a real outage, but checking
// only one would miss the other independently failing.
//
// Deliberately Redis-only, not also checking Postgres: keeps the check fast
// and avoids adding DB load on every poll. If Postgres/pgbouncer is down
// while Redis is fine, this reports healthy even though job processing is
// failing — an accepted v1 scoping call per issue #129's literal ask, not an
// oversight.
//
// Exported separately from start/stopHealthServer so tests can exercise the
// route directly via app.request() without binding a real port.
export const app = new Hono();

app.get("/healthz", (c) => {
  const statuses = {
    queues: queuesConnection.status,
    automation: automationConnection.status,
  };
  const allReady = Object.values(statuses).every((s) => s === "ready");
  if (allReady) {
    return c.json({ status: "ok" });
  }
  return c.json({ status: "error", redis: statuses }, 503);
});

let server: ServerType | null = null;

export function startHealthServer(): void {
  server = serve({ fetch: app.fetch, port: PORT }, () => {
    logger.info({ port: PORT }, "Worker health server listening");
  });
  // serve() returns the underlying http.Server before it's necessarily bound;
  // a bind failure (e.g. EADDRINUSE) emits an 'error' event which, left
  // unhandled, would throw and crash the whole worker process — the health
  // check itself isn't worth taking job processing down for.
  server.on("error", (err) => {
    logger.error({ err, port: PORT }, "Worker health server failed to start");
    server = null;
  });
}

export async function stopHealthServer(): Promise<void> {
  if (!server) return;
  const current = server;
  await new Promise<void>((resolve) => {
    current.close((err) => {
      // http.Server#close's callback receives an Error if the server wasn't
      // open when closed (e.g. it never finished binding, or startup already
      // failed via the 'error' handler above) — benign for shutdown purposes,
      // so this resolves either way rather than rejecting and turning a
      // no-op close into an unhandled rejection that could abort the rest of
      // index.ts's shutdown Promise.all.
      if (err) {
        logger.warn({ err }, "Worker health server close reported an error");
      }
      resolve();
    });
  });
  server = null;
}
