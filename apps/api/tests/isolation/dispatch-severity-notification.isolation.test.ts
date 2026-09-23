/**
 * Tenant isolation for the dispatch_severity_notification automation action —
 * docs/specs/oncall-routing.md T31, R16-R20. Runs the action end-to-end
 * through a real automation rule against a real database (same convention as
 * resolve-oncall.isolation.test.ts), not mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  withTenantContext,
  outboxEvents,
  automationExecutions,
  entityInstances,
  onCallSchedules,
  notificationPolicies,
  notifications,
  notificationRecipients,
  teams,
  tenants,
  tenantUsers,
  adminAuditLog,
} from "@platform/db";
import { env } from "@platform/config";
import {
  createEntityType,
  createEntity,
  addEntityField,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT_A = "aaaaaaaa-4444-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-4444-4000-b000-000000000002";
const USER_A = "aaaaaaaa-4444-4000-a000-000000000900";
const USER_B = "bbbbbbbb-4444-4000-b000-000000000900";
const ASSIGNEE_A = "aaaaaaaa-4444-4000-a000-000000000901";

let redis: Redis;
let entityTypeA: EntityType;
let teamAId: string;
let teamBId: string;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Dispatch Severity Isolation A",
      slug: `dispatch-severity-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Dispatch Severity Isolation B",
      slug: `dispatch-severity-isolation-b-${TENANT_B}`,
    },
  ]);

  const [teamA] = await db
    .insert(teams)
    .values({ tenantId: TENANT_A, name: "Team A", createdBy: USER_A })
    .returning({ id: teams.id });
  const [teamB] = await db
    .insert(teams)
    .values({ tenantId: TENANT_B, name: "Team B", createdBy: USER_B })
    .returning({ id: teams.id });
  teamAId = teamA!.id;
  teamBId = teamB!.id;

  await db.insert(tenantUsers).values([
    { tenantId: TENANT_A, userId: USER_A },
    { tenantId: TENANT_A, userId: ASSIGNEE_A },
    { tenantId: TENANT_B, userId: USER_B },
  ]);

  await db.insert(onCallSchedules).values([
    {
      tenantId: TENANT_A,
      teamId: teamAId,
      label: "Week 1",
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
      primaryUserId: USER_A,
      backupUserId: USER_A,
      createdBy: USER_A,
    },
    {
      tenantId: TENANT_B,
      teamId: teamBId,
      label: "Week 1",
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
      primaryUserId: USER_B,
      backupUserId: USER_B,
      createdBy: USER_B,
    },
  ]);

  // Tenant B has a global "high" severity policy requesting sms+whatsapp.
  // Tenant A has no policy of its own, so its dispatch must fall back to
  // the hardcoded email-only default -- Tenant B's policy must never leak
  // into Tenant A's resolution even though both share the same severity.
  await db.insert(notificationPolicies).values({
    tenantId: TENANT_B,
    severity: "high",
    channels: ["sms", "whatsapp"],
    notifyBackup: true,
    notifyEscalationManager: false,
    createdBy: USER_B,
  });

  // team_id is now auto-seeded by createEntityType itself
  // (docs/specs/team-assign-oncall-fallback.md R2, entity-types.ts), along
  // with title -- no longer registered manually here (that used to be
  // needed back when team_id was a documented-dormant, un-seeded field;
  // doing it again now would collide with the auto-seed on the unique
  // (entity_type_id, name) constraint).
  entityTypeA = await createEntityType(db, TENANT_A, {
    name: `dispatch_severity_ticket_${TENANT_A}_${Date.now()}`,
    plural: "tickets",
    allowCustomFields: true,
  });
  await addEntityField(db, TENANT_A, entityTypeA.id, {
    name: "severity",
    label: "Severity",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 1,
    sensitivity: "public",
  });
});

afterAll(async () => {
  await redis.quit();
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await withTenantContext(tenantId, async (tx) => {
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, tenantId));
      await tx
        .delete(automationExecutions)
        .where(eq(automationExecutions.tenantId, tenantId));
      await tx
        .delete(entityInstances)
        .where(eq(entityInstances.tenantId, tenantId));
    });
  }
  await db
    .delete(notificationRecipients)
    .where(inArray(notificationRecipients.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(notifications)
    .where(inArray(notifications.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(notificationPolicies)
    .where(inArray(notificationPolicies.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(adminAuditLog)
    .where(inArray(adminAuditLog.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(tenantUsers)
    .where(inArray(tenantUsers.tenantId, [TENANT_A, TENANT_B]));
  await db
    .delete(onCallSchedules)
    .where(inArray(onCallSchedules.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(teams).where(inArray(teams.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("dispatch_severity_notification action — tenant isolation", () => {
  it("never uses Tenant B's notification policy or schedule when dispatching for Tenant A", async () => {
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeA.id,
        fields: { title: "Test ticket", team_id: teamAId, severity: "high" },
        assignedTo: ASSIGNEE_A,
      }),
    );

    await createAutomationRule(db, TENANT_A, {
      name: "Dispatch severity notification on creation",
      triggerType: "entity.created",
      triggerConfig: {},
      actions: [{ type: "dispatch_severity_notification", config: {} }],
    });

    await executeAutomationRules(
      db,
      TENANT_A,
      {
        version: 1,
        tenantId: TENANT_A,
        eventType: "entity.created",
        instanceId: instance.id,
        entityTypeId: entityTypeA.id,
        fields: { team_id: teamAId, severity: "high" },
        createdBy: USER_A,
      },
      0,
      redis,
    );

    const rows = await db
      .select({
        channel: notifications.channel,
        userId: notificationRecipients.userId,
      })
      .from(notifications)
      .innerJoin(
        notificationRecipients,
        eq(notificationRecipients.notificationId, notifications.id),
      )
      .where(eq(notifications.tenantId, TENANT_A));

    // Tenant B's policy (sms+whatsapp, notifyBackup) must never apply here --
    // Tenant A has no policy of its own, so only the hardcoded email-only
    // default fires, to the assignee alone (no backup: default notifyBackup
    // is true, but severity "high" != "critical" and default channels are
    // email-only regardless).
    expect(rows.every((r) => r.channel === "email")).toBe(true);
    expect(new Set(rows.map((r) => r.userId))).toEqual(
      new Set([ASSIGNEE_A, USER_A]),
    );
    // USER_A is Tenant A's own backup (default notifyBackup=true applies
    // even to the hardcoded fallback policy), never USER_B.
    expect(rows.some((r) => r.userId === USER_B)).toBe(false);
  });
});
