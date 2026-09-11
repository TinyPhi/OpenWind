/**
 * Tenant isolation for the resolve_oncall automation action —
 * docs/specs/oncall-routing.md T16, R12. Runs the action end-to-end through
 * a real automation rule against a real database (same convention as
 * automation-assign-create-entity.isolation.test.ts), not mocks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  withTenantContext,
  outboxEvents,
  automationExecutions,
  entityInstances,
  onCallSchedules,
  teams,
  tenants,
  tenantUsers,
  adminAuditLog,
} from "@platform/db";
import { env } from "@platform/config";
import {
  createEntityType,
  createEntity,
  getEntity,
  addEntityField,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT_A = "aaaaaaaa-6666-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-6666-4000-b000-000000000002";
const USER_A = "aaaaaaaa-6666-4000-a000-000000000900";
const USER_B = "bbbbbbbb-6666-4000-b000-000000000900";

let redis: Redis;
let entityTypeA: EntityType;
let teamAId: string;
let teamBId: string;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Resolve Oncall Isolation A",
      slug: `resolve-oncall-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Resolve Oncall Isolation B",
      slug: `resolve-oncall-isolation-b-${TENANT_B}`,
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

  // A user is "resolvable" (isUserResolvable/resolveOncallCascade in
  // @platform/teams) only if a tenant_users row exists for them -- without
  // this, the cascade would find every tier unresolvable and treat it as an
  // exhausted cascade (R8b fail-open), never actually assigning.
  await db.insert(tenantUsers).values([
    { tenantId: TENANT_A, userId: USER_A },
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
      createdBy: USER_A,
    },
    {
      tenantId: TENANT_B,
      teamId: teamBId,
      label: "Week 1",
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
      primaryUserId: USER_B,
      createdBy: USER_B,
    },
  ]);

  // Only Tenant A needs an entity type -- both tests below create tickets
  // in Tenant A (one referencing its own team, one referencing Tenant B's
  // team id to prove cross-tenant isolation), so Tenant B needs no
  // entity_types/entity_instances rows of its own.
  entityTypeA = await createEntityType(db, TENANT_A, {
    name: `resolve_oncall_ticket_${TENANT_A}_${Date.now()}`,
    plural: "tickets",
    allowCustomFields: true,
  });
  // team_id isn't yet a seeded system field on the real ticket entity type
  // (modules/helpdesk/seed/001_entity_types.sql's header comment tracks
  // that separately) -- registered here as a plain custom field so this
  // test exercises the action against a real DB row, not a mock.
  await addEntityField(db, TENANT_A, entityTypeA.id, {
    name: "team_id",
    label: "Team",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
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

describe("resolve_oncall action — tenant isolation", () => {
  it("auto-assigns using only the triggering tenant's own schedule", async () => {
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeA.id,
        fields: { team_id: teamAId },
      }),
    );

    await createAutomationRule(db, TENANT_A, {
      name: "Resolve on-call on creation",
      triggerType: "entity.created",
      triggerConfig: {},
      actions: [{ type: "resolve_oncall", config: {} }],
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
        fields: { team_id: teamAId },
        createdBy: USER_A,
      },
      0,
      redis,
    );

    const updated = await withTenantContext(TENANT_A, (tx) =>
      getEntity(tx, TENANT_A, instance.id),
    );
    expect(updated?.assignedTo).toBe(USER_A);
  });

  it("never assigns a Tenant A ticket to Tenant B's primary even when the tickets share a team NAME collision path", async () => {
    // A team_id that only exists under TENANT_B must resolve to "no schedule"
    // for TENANT_A -- getActiveScheduleForTeam is tenant-scoped, so a
    // cross-tenant team_id can never leak Tenant B's on-call user into a
    // Tenant A assignment.
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeA.id,
        fields: { team_id: teamBId },
      }),
    );

    await createAutomationRule(db, TENANT_A, {
      name: "Resolve on-call on creation (cross-tenant team_id)",
      triggerType: "entity.created",
      triggerConfig: {},
      actions: [{ type: "resolve_oncall", config: {} }],
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
        fields: { team_id: teamBId },
        createdBy: USER_A,
      },
      0,
      redis,
    );

    const updated = await withTenantContext(TENANT_A, (tx) =>
      getEntity(tx, TENANT_A, instance.id),
    );
    expect(updated?.assignedTo).not.toBe(USER_B);
    expect(updated?.assignedTo).toBeNull();

    const auditRows = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT_A),
          eq(adminAuditLog.resourceId, instance.id),
        ),
      );
    expect(auditRows.some((r) => r.action === "oncall.no_schedule")).toBe(true);
  });

  // PR #597 review, B2: the entity.created path above is covered, but the
  // entity.updated path extracts teamId from event.changed["team_id"].new
  // rather than a DB column -- the only guards are getActiveScheduleForTeam's
  // tenant filter and RLS on on_call_schedules. Those guards are correct in
  // code (same function, same tenant-scoped query, as the entity.created
  // path); this proves it end-to-end for the update entry point too, not
  // just by code inspection.
  it("entity.updated: never assigns a Tenant A ticket to Tenant B's primary via a cross-tenant team_id change", async () => {
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeA.id,
        fields: {},
      }),
    );

    await createAutomationRule(db, TENANT_A, {
      name: "Resolve on-call on update (cross-tenant team_id)",
      triggerType: "entity.updated",
      triggerConfig: {},
      actions: [{ type: "resolve_oncall", config: {} }],
    });

    await executeAutomationRules(
      db,
      TENANT_A,
      {
        version: 1,
        tenantId: TENANT_A,
        eventType: "entity.updated",
        instanceId: instance.id,
        entityTypeId: entityTypeA.id,
        actorId: USER_A,
        changed: { team_id: { old: null, new: teamBId } },
      },
      0,
      redis,
    );

    const updated = await withTenantContext(TENANT_A, (tx) =>
      getEntity(tx, TENANT_A, instance.id),
    );
    expect(updated?.assignedTo).not.toBe(USER_B);
    expect(updated?.assignedTo).toBeNull();

    const auditRows = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT_A),
          eq(adminAuditLog.resourceId, instance.id),
        ),
      );
    expect(auditRows.some((r) => r.action === "oncall.no_schedule")).toBe(true);
  });
});
