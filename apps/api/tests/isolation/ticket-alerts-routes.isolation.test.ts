/**
 * Integration tests for the ticket-alerts API routes (docs/specs/ticket-alerts.md
 * §R1, §R2, §R3, §R4, §R9), run against a real Postgres instance (no mocks).
 *
 * Covers: access-gated create, past-fire_at rejection, the 20-cap, app-layer
 * visibility (creator-always / scope='all' gated on explicit ticket access),
 * creator-only edit/cancel with the 403-vs-404 split (§R3), and the
 * fired/cancelled read-only guard (§R9 — enforced here via cancel, since
 * firing itself is Phase 3/T8).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Redis/BullMQ is a service boundary (testing-conventions.md) — this suite
// exercises route/DB logic, not queue delivery (that's alert-scheduler.ts/
// alert-worker.ts's job, covered separately in Phase 3). This environment's
// docker-compose deliberately has no host-reachable Redis port (see
// docker-compose.yml's redis service comment), so mock the cancel call here
// rather than depend on host-to-container Redis connectivity.
vi.mock("../../src/lib/ticket-alerts-queue.js", () => ({
  ticketAlertsQueue: { remove: vi.fn().mockResolvedValue(undefined) },
  ticketAlertJobId: (id: string) => `alert:${id}`,
}));
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityInstances,
  entityTypes,
  ticketAlerts,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { createAlertHandler } from "../../src/routes/entities/create-alert.js";
import { listAlertsHandler } from "../../src/routes/entities/list-alerts.js";
import { updateAlertHandler } from "../../src/routes/entities/update-alert.js";
import { deleteAlertHandler } from "../../src/routes/entities/delete-alert.js";

const TENANT = "cccccccc-0042-4000-c000-000000000042";
const OWNER = "isolation-alert-owner";
const MATE = "isolation-alert-mate"; // explicit access via __accessUsers
const STRANGER = "isolation-alert-stranger"; // no access at all

let instanceId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Isolation Tenant (ticket-alerts routes)",
    slug: `isolation-alerts-routes-${Date.now()}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `isolation_alert_ticket_${Date.now()}`,
    plural: "isolation_alert_tickets",
    allowCustomFields: true,
  });

  const instance = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: OWNER,
  });
  instanceId = instance.id;

  // createEntity's field validation only persists fields declared on the
  // entity type — __accessUsers is a special, always-allowed key written
  // directly (see grant-access.ts), not via the createEntity fields payload.
  await db
    .update(entityInstances)
    .set({
      fields: {
        __accessUsers: { [MATE]: { level: "read_comment", tag: "manual" } },
      },
    })
    .where(eq(entityInstances.id, instanceId));
});

afterAll(async () => {
  await db.delete(ticketAlerts).where(eq(ticketAlerts.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

function makeApp(userId: string, roles: string[] = ["user"]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId: TENANT, userId, roles, email: "t@test.dev" });
      await next();
    },
  );
  app.post("/:id/alerts", ...createAlertHandler);
  app.get("/:id/alerts", ...listAlertsHandler);
  app.patch("/:id/alerts/:alertId", ...updateAlertHandler);
  app.delete("/:id/alerts/:alertId", ...deleteAlertHandler);
  return app;
}

function futureIso(hours = 1): string {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

describe("POST /:id/alerts — access + validation (§R1)", () => {
  it("owner can create a scope='me' alert", async () => {
    const res = await makeApp(OWNER).request(`/${instanceId}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "Follow up",
        fireAt: futureIso(),
        scope: "me",
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; status: string };
    };
    expect(data.status).toBe("pending");
  });

  it("a requester with no ticket access gets 404, not 403 (existence hidden)", async () => {
    const res = await makeApp(STRANGER).request(`/${instanceId}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Nope", fireAt: futureIso(), scope: "me" }),
    });
    expect(res.status).toBe(404);
  });

  it("a fireAt in the past is rejected with 422", async () => {
    const res = await makeApp(OWNER).request(`/${instanceId}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "Too late",
        fireAt: new Date(Date.now() - 3600_000).toISOString(),
        scope: "me",
      }),
    });
    expect(res.status).toBe(422);
  });

  it("scope='all' snapshots the explicit access list (creator + assignee/__accessUsers), not org-wide roles", async () => {
    const res = await makeApp(OWNER).request(`/${instanceId}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "Escalation",
        fireAt: futureIso(),
        scope: "all",
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { id: string; recipientsSnapshot: string[] };
    };
    expect(new Set(data.recipientsSnapshot)).toEqual(new Set([OWNER, MATE]));
  });

  it("20th pending alert succeeds, 21st is rejected with 422 (soft cap)", async () => {
    for (let i = 0; i < 18; i++) {
      // 2 already created above for OWNER
      const res = await makeApp(OWNER).request(`/${instanceId}/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: `Bulk ${i}`,
          fireAt: futureIso(),
          scope: "me",
        }),
      });
      expect(res.status).toBe(201);
    }
    const overCap = await makeApp(OWNER).request(`/${instanceId}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "Over cap",
        fireAt: futureIso(),
        scope: "me",
      }),
    });
    expect(overCap.status).toBe(422);
  });
});

describe("GET /:id/alerts — visibility (§R2)", () => {
  it("owner's scope='me' alerts are invisible to a user with ticket access but not the creator", async () => {
    const res = await makeApp(MATE).request(`/${instanceId}/alerts`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { scope: string }[] };
    expect(data.every((a) => a.scope === "all")).toBe(true);
  });

  it("scope='all' alerts are visible to a user with explicit ticket access", async () => {
    const res = await makeApp(MATE).request(`/${instanceId}/alerts`);
    const { data } = (await res.json()) as { data: { note: string }[] };
    expect(data.some((a) => a.note === "Escalation")).toBe(true);
  });

  it("a user with no ticket access gets 404 on list", async () => {
    const res = await makeApp(STRANGER).request(`/${instanceId}/alerts`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH/DELETE /:id/alerts/:alertId — ownership (§R3) and fired/cancelled guard (§R9)", () => {
  it("non-creator gets 403 editing a scope='all' alert (existence already visible)", async () => {
    const list = await makeApp(OWNER).request(`/${instanceId}/alerts`);
    const { data } = (await list.json()) as {
      data: { id: string; scope: string }[];
    };
    const allAlert = data.find((a) => a.scope === "all")!;

    const res = await makeApp(MATE).request(
      `/${instanceId}/alerts/${allAlert.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "hijacked" }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("non-creator gets 404 editing a scope='me' alert it can't even see", async () => {
    const list = await makeApp(OWNER).request(`/${instanceId}/alerts`);
    const { data } = (await list.json()) as {
      data: { id: string; scope: string }[];
    };
    const meAlert = data.find((a) => a.scope === "me")!;

    const res = await makeApp(MATE).request(
      `/${instanceId}/alerts/${meAlert.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "hijacked" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("creator can edit their own pending alert, rescheduling fireAt", async () => {
    const list = await makeApp(OWNER).request(`/${instanceId}/alerts`);
    const { data } = (await list.json()) as {
      data: { id: string; scope: string }[];
    };
    const meAlert = data.find((a) => a.scope === "me")!;
    const newFireAt = futureIso(5);

    const res = await makeApp(OWNER).request(
      `/${instanceId}/alerts/${meAlert.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fireAt: newFireAt }),
      },
    );
    expect(res.status).toBe(200);
    const { data: updated } = (await res.json()) as {
      data: { fireAt: string };
    };
    expect(new Date(updated.fireAt).toISOString()).toBe(
      new Date(newFireAt).toISOString(),
    );
  });

  it("creator can cancel their own pending alert; a second cancel returns 409", async () => {
    const list = await makeApp(OWNER).request(`/${instanceId}/alerts`);
    const { data } = (await list.json()) as {
      data: { id: string; scope: string }[];
    };
    const meAlert = data.find((a) => a.scope === "me")!;

    const first = await makeApp(OWNER).request(
      `/${instanceId}/alerts/${meAlert.id}`,
      {
        method: "DELETE",
      },
    );
    expect(first.status).toBe(204);

    const second = await makeApp(OWNER).request(
      `/${instanceId}/alerts/${meAlert.id}`,
      {
        method: "DELETE",
      },
    );
    expect(second.status).toBe(409);
  });

  it("editing a cancelled alert returns 409, not a silent update", async () => {
    const list = await makeApp(OWNER).request(`/${instanceId}/alerts`);
    const { data } = (await list.json()) as {
      data: { id: string; status: string }[];
    };
    const cancelled = data.find((a) => a.status === "cancelled")!;

    const res = await makeApp(OWNER).request(
      `/${instanceId}/alerts/${cancelled.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "too late" }),
      },
    );
    expect(res.status).toBe(409);
  });
});
