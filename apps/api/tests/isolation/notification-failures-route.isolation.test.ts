/**
 * GET /entities/:id/notification-failures — behaviour, role gate and tenant
 * isolation against a real Postgres with RLS (SET LOCAL ROLE app_user).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  adminAuditLog,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { listNotificationFailuresHandler } from "../../src/routes/entities/list-notification-failures.js";

const TENANT_A = "dddddddd-0000-4000-d000-000000000571";
const TENANT_B = "dddddddd-0000-4000-d000-000000000572";
const SECRET_TEXT = "smtp 550 provider-internal-detail";

const HOUR = 3_600_000;
const ago = (hours: number): Date => new Date(Date.now() - hours * HOUR);

let ticketA1: string;
let ticketA2: string;
let ticketB: string;

async function makeTicket(tenantId: string, typeId: string): Promise<string> {
  const e = await createEntity(db, tenantId, {
    entityTypeId: typeId,
    fields: {},
    createdBy: "isolation-owner",
  });
  return e.id;
}

function row(
  tenantId: string,
  resourceId: string,
  action: "notification.channel_failed" | "notification.dispatched",
  createdAt: Date,
  channel = "sms",
): typeof adminAuditLog.$inferInsert {
  return {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: "ticket",
    resourceId,
    action,
    createdAt,
    metadata: { channel, errorSummary: SECRET_TEXT },
  };
}

let nullTenantTypeId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation 571 A",
      slug: `isolation-571a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Isolation 571 B",
      slug: `isolation-571b-${Date.now()}`,
    },
  ]);
  const type = await createEntityType(db, null, {
    name: `isolation_nf_ticket_${Date.now()}`,
    plural: "isolation_nf_tickets",
    allowCustomFields: true,
  });
  nullTenantTypeId = type.id;
  ticketA1 = await makeTicket(TENANT_A, type.id);
  ticketA2 = await makeTicket(TENANT_A, type.id);
  ticketB = await makeTicket(TENANT_B, type.id);

  await db
    .insert(adminAuditLog)
    .values([
      row(TENANT_A, ticketA1, "notification.channel_failed", ago(1), "sms"),
      row(TENANT_A, ticketA1, "notification.channel_failed", ago(2), "email"),
      row(TENANT_A, ticketA1, "notification.channel_failed", ago(30), "voice"),
      row(TENANT_A, ticketA1, "notification.dispatched", ago(1)),
      row(TENANT_A, ticketA2, "notification.channel_failed", ago(1), "sms"),
      row(TENANT_B, ticketB, "notification.channel_failed", ago(1), "sms"),
    ]);
});

afterAll(async () => {
  for (const t of [TENANT_A, TENANT_B]) {
    await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, t));
    await db.delete(entityInstances).where(eq(entityInstances.tenantId, t));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
  // The type was created with a null tenant_id, so the per-tenant delete
  // above never matches it.
  await db.delete(entityTypes).where(eq(entityTypes.id, nullTenantTypeId));
});

function makeApp(tenantId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId: "isolation-agent",
        roles,
        email: "t@test.dev",
      });
      await next();
    },
  );
  app.get("/:id/notification-failures", ...listNotificationFailuresHandler);
  return app;
}

interface Body {
  data: { failures: Array<{ channel: string; occurredAt: string }> };
}

describe("GET /entities/:id/notification-failures", () => {
  it("returns this ticket's channel failures from the last 24 hours, newest first", async () => {
    const res = await makeApp(TENANT_A, ["agent"]).request(
      `/${ticketA1}/notification-failures`,
    );
    const body = (await res.json()) as Body;

    expect(res.status).toBe(200);
    expect(body.data.failures.map((f) => f.channel)).toEqual(["sms", "email"]);
  });

  it("leaves out other actions, older entries and other tickets", async () => {
    const res = await makeApp(TENANT_A, ["admin"]).request(
      `/${ticketA2}/notification-failures`,
    );
    const body = (await res.json()) as Body;

    expect(body.data.failures).toHaveLength(1);
  });

  it("returns only channel and time, never the provider error text", async () => {
    const res = await makeApp(TENANT_A, ["agent"]).request(
      `/${ticketA1}/notification-failures`,
    );
    const text = await res.text();

    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain("errorSummary");
    expect(Object.keys(JSON.parse(text).data.failures[0]).sort()).toEqual([
      "channel",
      "occurredAt",
    ]);
  });

  it("refuses a requester without the agent or admin role", async () => {
    const res = await makeApp(TENANT_A, ["user"]).request(
      `/${ticketA1}/notification-failures`,
    );

    expect(res.status).toBe(403);
  });

  it("returns 404 for another tenant's ticket, with no failures leaked", async () => {
    const res = await makeApp(TENANT_A, ["admin"]).request(
      `/${ticketB}/notification-failures`,
    );

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("sms");
  });

  it("returns 404 for a ticket that does not exist", async () => {
    const res = await makeApp(TENANT_A, ["admin"]).request(
      `/00000000-0000-4000-8000-000000000000/notification-failures`,
    );

    expect(res.status).toBe(404);
  });
});

describe("GET /entities/:id/notification-failures — malformed id", () => {
  it("rejects an id that is not a uuid at validation, before any database work", async () => {
    const res = await makeApp(TENANT_A, ["admin"]).request(
      "/not-a-uuid/notification-failures",
    );
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).not.toMatch(/invalid input syntax|select /i);
  });
});
