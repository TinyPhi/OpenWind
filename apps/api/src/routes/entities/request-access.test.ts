import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

vi.mock("drizzle-orm", () => {
  const noop = vi.fn(() => "sql");
  return { eq: noop, and: noop };
});

let currentAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-requester",
  roles: ["user"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", currentAuth);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("../../lib/handle-entity-error.js", () => ({
  handleEntityError: (_c: unknown, err: unknown) => {
    throw err;
  },
}));

const mockEmitAccessRequestSubmitted = vi.fn();
vi.mock("../../lib/emit-access-event.js", () => ({
  emitAccessRequestSubmitted: (...args: unknown[]) =>
    mockEmitAccessRequestSubmitted(...args),
}));

const entityInstancesTable = {
  id: "entity_instances.id",
  tenantId: "entity_instances.tenant_id",
};
const accessRequestsTable = {
  id: "access_requests.id",
  tenantId: "access_requests.tenant_id",
  instanceId: "access_requests.instance_id",
  requesterId: "access_requests.requester_id",
};
const outboxEventsTable = { id: "outbox_events.id" };

const INST_ID = "00000000-0000-0000-0000-000000000002";
const NEW_REQ_ID = "00000000-0000-0000-0000-0000000000cc";

let instanceRow: { id: string } | null;
let existingRequests: Array<{ id: string; status: string }> = [];
let currentFromTable: unknown;
let currentInsertTable: unknown;
const outboxInserts: Array<{ eventType: string; payload: unknown }> = [];

const mockTx = {
  select: () => mockTx,
  from: (table: unknown) => {
    currentFromTable = table;
    return mockTx;
  },
  // entityInstances lookup chains `.limit(1)` after `.where()`; the
  // accessRequests lookup awaits `.where()` directly with no `.limit()` —
  // `.where()` must resolve for that table, but stay chainable for the other.
  where: () => {
    if (currentFromTable === accessRequestsTable) {
      return Promise.resolve(existingRequests);
    }
    return mockTx;
  },
  limit: () => Promise.resolve(instanceRow ? [instanceRow] : []),
  insert: (table: unknown) => {
    currentInsertTable = table;
    return mockTx;
  },
  values: (arg: unknown) => {
    if (currentInsertTable === outboxEventsTable) {
      const payload = arg as { eventType: string };
      outboxInserts.push({ eventType: payload.eventType, payload });
    }
    return mockTx;
  },
  returning: () => Promise.resolve([{ id: NEW_REQ_ID }]),
  update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
};

vi.mock("@platform/db", () => ({
  entityInstances: entityInstancesTable,
  accessRequests: accessRequestsTable,
  outboxEvents: outboxEventsTable,
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
}));

const { requestAccessHandler } = await import("./request-access.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/access-requests", ...requestAccessHandler);
  return app;
}

describe("POST /entities/:id/access-requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentFromTable = undefined;
    currentInsertTable = undefined;
    outboxInserts.length = 0;
    instanceRow = { id: INST_ID };
    existingRequests = [];
    currentAuth = {
      tenantId: "t-aaa",
      userId: "u-requester",
      roles: ["user"],
      email: "test@example.com",
    };
  });

  it("creates a fresh access request and fires access_request.created", async () => {
    // No prior rows for this requester on this instance — the `select`
    // resolving `existingRequests` (empty) then falls through to insert.
    const res = await makeApp().request(`/${INST_ID}/access-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedLevel: "read_comment" }),
    });

    // The mockTx.limit() only special-cases entityInstancesTable; the
    // access_requests select resolves via the generic `[]` branch, so
    // `existing` is empty and the handler takes the fresh-insert path.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.created).toBe(true);
    expect(body.data.id).toBe(NEW_REQ_ID);

    const createdEvent = outboxInserts.find(
      (o) => o.eventType === "access_request.created",
    );
    expect(createdEvent).toBeDefined();
    const createdPayload = createdEvent?.payload as {
      payload: { instanceId: string; requestId: string };
    };
    expect(createdPayload.payload.instanceId).toBe(INST_ID);
    expect(createdPayload.payload.requestId).toBe(NEW_REQ_ID);

    // §3.6 — the request itself gets its own history line, independent of
    // the access_request.created outbox write above (which drives 2.9's
    // notification + the live room push, not history).
    expect(mockEmitAccessRequestSubmitted).toHaveBeenCalledWith(
      "t-aaa",
      INST_ID,
      "u-requester",
      "read_comment",
    );
  });

  it("re-requesting against an existing pending row updates the level and still logs a new history line (§3.6)", async () => {
    existingRequests = [{ id: "existing-req-1", status: "pending" }];

    const res = await makeApp().request(`/${INST_ID}/access-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedLevel: "read_write" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.created).toBe(false);
    expect(body.data.id).toBe("existing-req-1");

    // No fresh access_request.created — that only fires for a genuinely new
    // row (2.9's live-push path is deliberately not re-fired on every
    // re-request), but each submission still gets its own history line.
    expect(
      outboxInserts.find((o) => o.eventType === "access_request.created"),
    ).toBeUndefined();
    expect(mockEmitAccessRequestSubmitted).toHaveBeenCalledWith(
      "t-aaa",
      INST_ID,
      "u-requester",
      "read_write",
    );
  });

  it("returns 404 for an instance that doesn't exist in this tenant, without firing any outbox event", async () => {
    instanceRow = null;

    const res = await makeApp().request(`/${INST_ID}/access-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(outboxInserts.length).toBe(0);
  });
});
