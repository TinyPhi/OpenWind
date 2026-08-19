/**
 * Tenant isolation + idempotency tests for the in-app notification hub's new
 * tables (docs/specs/in-app-notification-hub.md, T11).
 *
 * notifications / notification_recipients use single-tenant RLS
 * (tenant_id = app.tenant_id), the same pattern as most tenant-scoped tables
 * in this repo (not the dual tenant+user policy saved_views uses) — "my
 * notifications" filtering is an explicit WHERE user_id = ? at the
 * application layer, same as workflow_events/entity_instances.
 *
 * Tests run against a real Postgres instance (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  withTenantContext,
  tenants,
  notifications,
  notificationRecipients,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { unreadNotificationCountHandler } from "../../src/routes/notifications/unread-count.js";

const TENANT_A = "aaaaaaaa-3333-4000-a000-000000000036";
const TENANT_B = "bbbbbbbb-3333-4000-b000-000000000036";
const USER_A = "notif_isolation_user_a";
const USER_B = "notif_isolation_user_b";

let notificationAId: string;
let notificationBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Notif Isolation Tenant A",
      slug: `notif-iso-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Notif Isolation Tenant B",
      slug: `notif-iso-b-${Date.now()}`,
    },
  ]);

  const [rowA] = await db
    .insert(notifications)
    .values({
      tenantId: TENANT_A,
      type: "entity.assigned",
      title: "New assignment",
      body: "Notification A",
      link: null,
    })
    .returning({ id: notifications.id });
  notificationAId = rowA!.id;

  await db.insert(notificationRecipients).values({
    notificationId: notificationAId,
    tenantId: TENANT_A,
    userId: USER_A,
  });

  const [rowB] = await db
    .insert(notifications)
    .values({
      tenantId: TENANT_B,
      type: "entity.assigned",
      title: "New assignment",
      body: "Notification B",
      link: null,
    })
    .returning({ id: notifications.id });
  notificationBId = rowB!.id;

  await db.insert(notificationRecipients).values({
    notificationId: notificationBId,
    tenantId: TENANT_B,
    userId: USER_B,
  });
});

afterAll(async () => {
  // DB owner connection bypasses RLS — safe to clean up directly.
  await db
    .delete(notificationRecipients)
    .where(eq(notificationRecipients.tenantId, TENANT_A));
  await db
    .delete(notificationRecipients)
    .where(eq(notificationRecipients.tenantId, TENANT_B));
  await db.delete(notifications).where(eq(notifications.tenantId, TENANT_A));
  await db.delete(notifications).where(eq(notifications.tenantId, TENANT_B));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("notifications — cross-tenant RLS isolation", () => {
  it("Tenant A context sees zero notifications rows owned by Tenant B", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.tenantId, TENANT_B));
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A context cannot fetch Tenant B's notification by known id", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.id, notificationBId));
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A context can read their own notification", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.id, notificationAId));
      expect(rows).toHaveLength(1);
    });
  });
});

describe("notification_recipients — cross-tenant RLS isolation", () => {
  it("Tenant A context sees zero recipient rows owned by Tenant B", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: notificationRecipients.id })
        .from(notificationRecipients)
        .where(eq(notificationRecipients.tenantId, TENANT_B));
      expect(rows).toHaveLength(0);
    });
  });

  it("WITH CHECK rejects INSERT when tenant_id does not match context tenant", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(notificationRecipients).values({
          notificationId: notificationAId,
          tenantId: TENANT_B, // wrong — context is TENANT_A
          userId: USER_A,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("notification_recipients — idempotency (R1, R16)", () => {
  it("unique constraint rejects a duplicate (notification_id, user_id) — a simulated redelivery cannot create a second recipient row", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(notificationRecipients).values({
          notificationId: notificationAId,
          tenantId: TENANT_A,
          userId: USER_A, // duplicate of the row seeded in beforeAll
        }),
      ),
    ).rejects.toThrow();
  });

  it("the original recipient row is unaffected by the failed duplicate insert", async () => {
    const rows = await db
      .select({
        id: notificationRecipients.id,
        readAt: notificationRecipients.readAt,
      })
      .from(notificationRecipients)
      .where(eq(notificationRecipients.notificationId, notificationAId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.readAt).toBeNull();
  });
});

// ── notifications_type_check constraint coverage (docs/specs/port-nexus-ow-fixes.md R1) ──
// A CHECK constraint enum mismatch is invisible to a mocked-DB unit test -- it only
// surfaces as a real INSERT failure (silently dead-lettered in production). These tests
// insert against the real constraint, not a mock, to prove the DB layer itself accepts
// every type the application code is allowed to write.

const ALL_NOTIFICATION_TYPES = [
  "entity.assigned",
  "comment.mentioned",
  "comment.mention_access_granted",
  "comment.replied",
  "access.granted",
  "access.revoked",
  "workflow.sla_breached",
  "system.error",
  "automation.notify",
  "ticket.alert",
  "access.updated",
  "workflow.transitioned",
  "entity.updated",
  "entity.due_date_approaching",
  "access_request.created",
  "access_request.updated",
  "entity.unassigned",
] as const;

describe("notifications_type_check — accepts every application-known type (R1)", () => {
  const insertedIds: string[] = [];

  afterAll(async () => {
    // Scoped to exactly the rows this describe block inserted -- a blanket
    // delete on tenantId would also remove the beforeAll-seeded notificationA
    // fixture the later unread-count suite depends on.
    if (insertedIds.length === 0) return;
    await db
      .delete(notifications)
      .where(inArray(notifications.id, insertedIds));
  });

  it("inserts a notification with type 'entity.unassigned' successfully", async () => {
    const [row] = await db
      .insert(notifications)
      .values({
        tenantId: TENANT_A,
        type: "entity.unassigned",
        title: "Unassigned",
        body: "Ticket unassigned",
        link: null,
      })
      .returning({ id: notifications.id });
    expect(row?.id).toBeTruthy();
    if (row?.id) insertedIds.push(row.id);
  });

  it.each(ALL_NOTIFICATION_TYPES)(
    "accepts type '%s' without violating notifications_type_check",
    async (type) => {
      const [row] = await db
        .insert(notifications)
        .values({
          tenantId: TENANT_A,
          type,
          title: "Type coverage",
          body: "Constraint regression check",
          link: null,
        })
        .returning({ id: notifications.id });
      expect(row?.id).toBeTruthy();
      if (row?.id) insertedIds.push(row.id);
    },
  );

  it("rejects a type not on the allowlist", async () => {
    await expect(
      db.insert(notifications).values({
        tenantId: TENANT_A,
        type: "not.a.real.type",
        title: "Should fail",
        body: "Constraint should reject this",
        link: null,
      }),
    ).rejects.toThrow();
  });
});

// ── GET /notifications/unread-count (docs/specs/personal-dashboard.md R9) ────
// Through the real handler, not just raw RLS on the table — proves the route
// itself is tenant+user scoped end-to-end.

function makeUnreadCountApp(tenantId: string, userId: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: ["user"],
        email: "t@example.com",
      });
      await next();
    },
  );
  app.get("/unread-count", ...unreadNotificationCountHandler);
  return app;
}

describe("GET /notifications/unread-count — tenant + user isolation (R9)", () => {
  it("Tenant A / User A sees their own unread notification counted", async () => {
    const res = await makeUnreadCountApp(TENANT_A, USER_A).request(
      "/unread-count",
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { count: number } };
    expect(data.count).toBe(1);
  });

  it("Tenant B's user count is unaffected by Tenant A's data — proves no cross-tenant leakage", async () => {
    const res = await makeUnreadCountApp(TENANT_B, USER_B).request(
      "/unread-count",
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { count: number } };
    expect(data.count).toBe(1);
  });

  it("a user with zero notifications gets count 0, not an error", async () => {
    const res = await makeUnreadCountApp(
      TENANT_A,
      "unread-count-user-with-nothing",
    ).request("/unread-count");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { count: number } };
    expect(data.count).toBe(0);
  });
});
