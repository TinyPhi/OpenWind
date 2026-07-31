/**
 * Regression tests for three bugs found while manually testing the ticket
 * alerts feature live (docs/specs/ticket-alerts.md):
 *
 * 1. Edit-reschedule race: editing a pending alert before its original
 *    outbox row from creation has been polled left TWO undelivered outbox
 *    rows for the same alert. Whichever the scheduler polled first won the
 *    BullMQ schedule (verified live: a second queue.add() with an existing
 *    jobId is a silent no-op on the real job), so the edit's new fire time
 *    could be silently discarded. Fixed by voiding the stale row on edit.
 * 2. Cascading archive (confirm=true, ticket has active children) archives
 *    every descendant but the cascade-cancel hook only touched the
 *    top-level instance — descendants' pending alerts stayed active.
 * 3. The requiresConfirm path (archiving a ticket WITH children but WITHOUT
 *    ?confirm=true) archived nothing, yet the old code cancelled alerts
 *    anyway — alerts were wrongly cancelled on tickets that stayed active.
 *
 * Real Postgres connection (no mocks). Redis/BullMQ mocked at the service
 * boundary per testing-conventions.md.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  entityTypes,
  entityInstances,
  entityRelations,
  ticketAlerts,
  outboxEvents,
  workflows,
  workflowStates,
  workflowEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext } from "@platform/auth";
import { createAlertHandler } from "../../src/routes/entities/create-alert.js";
import { updateAlertHandler } from "../../src/routes/entities/update-alert.js";
import { createChildHandler } from "../../src/routes/entities/create-child.js";
import { archiveEntityHandler } from "../../src/routes/entities/archive.js";

vi.mock("../../src/lib/ticket-alerts-queue.js", () => ({
  ticketAlertsQueue: { remove: vi.fn().mockResolvedValue(undefined) },
  ticketAlertJobId: (id: string) => `alert-${id}`,
}));

const TENANT = "ffffffff-0042-4000-f000-000000000142";
const OWNER = "fixes-owner";

let entityTypeId: string;
let workflowId: string;

function futureIso(minutes = 60): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function makeApp(userId: string, roles: string[] = ["admin"]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId: TENANT, userId, roles, email: "t@test.dev" });
      await next();
    },
  );
  app.post("/:id/alerts", ...createAlertHandler);
  app.patch("/:id/alerts/:alertId", ...updateAlertHandler);
  app.post("/:id/children", ...createChildHandler);
  app.post("/:id/archive", ...archiveEntityHandler);
  return app;
}

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Isolation Tenant (ticket-alerts fixes)",
    slug: `isolation-alerts-fixes-${Date.now()}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `isolation_fixes_ticket_${Date.now()}`,
    plural: "isolation_fixes_tickets",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "Isolation fixes workflow",
      initialState: "open",
      maxChildDepth: 1,
      maxChildrenPerParent: 10,
    })
    .returning({ id: workflows.id });
  workflowId = workflow!.id;

  await db.insert(workflowStates).values([
    {
      workflowId,
      tenantId: TENANT,
      name: "open",
      label: "Open",
      sortOrder: 0,
    },
  ]);
});

afterAll(async () => {
  await db.delete(ticketAlerts).where(eq(ticketAlerts.tenantId, TENANT));
  await db.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
  await db.delete(entityRelations).where(eq(entityRelations.tenantId, TENANT));
  await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("Fix #1: edit-reschedule race — stale outbox row is voided on edit", () => {
  it("leaves exactly one undelivered ticket.alert_scheduled outbox row after an edit, not two", async () => {
    const instance = await createEntity(db, TENANT, {
      entityTypeId,
      fields: {},
      createdBy: OWNER,
      workflowId,
      currentState: "open",
    });

    const createRes = await makeApp(OWNER).request(`/${instance.id}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "first",
        fireAt: futureIso(60),
        scope: "me",
      }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as {
      data: { id: string };
    };

    // Edit BEFORE any poller runs — simulates the exact race: the original
    // outbox row from creation is still undelivered when the edit lands.
    const editRes = await makeApp(OWNER).request(
      `/${instance.id}/alerts/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fireAt: futureIso(120) }),
      },
    );
    expect(editRes.status).toBe(200);

    const rows = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ id: outboxEvents.id, deliveredAt: outboxEvents.deliveredAt })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "ticket.alert_scheduled"),
          ),
        ),
    );

    const stillUndelivered = rows.filter((r) => r.deliveredAt === null);
    expect(stillUndelivered).toHaveLength(1);
  });
});

describe("Fix #2/#3: archive cascade-cancel", () => {
  it("cancels pending alerts on descendant tickets when a parent is archived with confirm=true", async () => {
    const parent = await createEntity(db, TENANT, {
      entityTypeId,
      fields: {},
      createdBy: OWNER,
      workflowId,
      currentState: "open",
    });

    const childRes = await makeApp(OWNER).request(`/${parent.id}/children`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityTypeId, fields: {} }),
    });
    expect(childRes.status).toBe(201);
    const { data: childResult } = (await childRes.json()) as {
      data: { instance: { id: string } };
    };
    const child = childResult.instance;

    const childAlertRes = await makeApp(OWNER).request(`/${child.id}/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "child alert",
        fireAt: futureIso(),
        scope: "me",
      }),
    });
    expect(childAlertRes.status).toBe(201);
    const { data: childAlert } = (await childAlertRes.json()) as {
      data: { id: string };
    };

    // Without ?confirm=true, this must archive NOTHING — the old code
    // cancelled alerts on this path anyway, which was itself a bug.
    const promptRes = await makeApp(OWNER).request(`/${parent.id}/archive`, {
      method: "POST",
    });
    expect(promptRes.status).toBe(200);
    const { data: prompt } = (await promptRes.json()) as {
      data: { requiresConfirm?: boolean };
    };
    expect(prompt.requiresConfirm).toBe(true);

    const [stillPending] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({ status: ticketAlerts.status })
        .from(ticketAlerts)
        .where(eq(ticketAlerts.id, childAlert.id)),
    );
    expect(stillPending!.status).toBe("pending");

    // Now actually cascade-archive.
    const archiveRes = await makeApp(OWNER).request(
      `/${parent.id}/archive?confirm=true`,
      { method: "POST" },
    );
    expect(archiveRes.status).toBe(200);

    // cancelAllPendingAlertsForInstance is deliberately fire-and-forget
    // (void, matching emit-access-event.ts's best-effort philosophy) so the
    // archive response doesn't block on it — poll briefly rather than
    // asserting immediately after the response resolves.
    let status = "pending";
    for (let attempt = 0; attempt < 20 && status === "pending"; attempt++) {
      const [row] = await withTenantContext(TENANT, (tx) =>
        tx
          .select({ status: ticketAlerts.status })
          .from(ticketAlerts)
          .where(eq(ticketAlerts.id, childAlert.id)),
      );
      status = row!.status;
      if (status === "pending") await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe("cancelled");
  });
});
