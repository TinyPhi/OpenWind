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
  workflows,
  workflowEvents,
  automationRules,
} from "@platform/db";
import { env } from "@platform/config";
import {
  createEntityType,
  createEntity,
  getEntity,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import { createWorkflow } from "@platform/workflow-engine";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT_A = "aaaaaaaa-6666-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-6666-4000-b000-000000000002";
const USER_A = "aaaaaaaa-6666-4000-a000-000000000900";
const USER_B = "bbbbbbbb-6666-4000-b000-000000000900";
// Distinct from USER_A/USER_B -- only used as a workflow's createdBy, never
// inserted into tenant_users, so resolveWorkflowAdminFallback's contract
// ("createdBy regardless of resolvability", unlike the schedule cascade
// tiers) is exercised, not accidentally masked by it happening to also be
// schedule-resolvable.
const WORKFLOW_ADMIN_A = "aaaaaaaa-6666-4000-a000-000000000970";

let redis: Redis;
let entityTypeA: EntityType;
let teamAId: string;
let teamBId: string;
// docs/specs/team-assign-oncall-fallback.md R4/R5 fixtures -- a SEPARATE
// entity type + workflow from entityTypeA, so adding a governing workflow
// here doesn't change entityTypeA's existing fail-open assertions above
// (those deliberately have no workflow, proving the "no workflow at all"
// fully-fail-open path still works).
let entityTypeC: EntityType;
let teamCId: string; // no schedule at all
let teamDId: string; // schedule exists, every tier unresolvable

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
  // team_id is now auto-seeded by createEntityType itself
  // (docs/specs/team-assign-oncall-fallback.md R2, entity-types.ts), along
  // with title -- no longer registered manually here (that used to be
  // needed back when team_id was a documented-dormant, un-seeded field;
  // doing it again now would collide with the auto-seed on the unique
  // (entity_type_id, name) constraint).
  entityTypeA = await createEntityType(db, TENANT_A, {
    name: `resolve_oncall_ticket_${TENANT_A}_${Date.now()}`,
    plural: "tickets",
    allowCustomFields: true,
  });

  // docs/specs/team-assign-oncall-fallback.md R4/R5 fixtures.
  const [teamC] = await db
    .insert(teams)
    .values({
      tenantId: TENANT_A,
      name: "Team C (no schedule)",
      createdBy: USER_A,
    })
    .returning({ id: teams.id });
  const [teamD] = await db
    .insert(teams)
    .values({
      tenantId: TENANT_A,
      name: "Team D (unresolvable cascade)",
      createdBy: USER_A,
    })
    .returning({ id: teams.id });
  teamCId = teamC!.id;
  teamDId = teamD!.id;

  // Every tier populated, but none of these ids has a tenant_users row --
  // resolveOncallCascade's own resolvability check makes this an exhausted
  // cascade (R8b), distinct from teamC's "no schedule row at all".
  await db.insert(onCallSchedules).values({
    tenantId: TENANT_A,
    teamId: teamDId,
    label: "Unresolvable rotation",
    startsAt: new Date(Date.now() - 3600_000),
    endsAt: new Date(Date.now() + 3600_000),
    primaryUserId: "u-unresolvable-primary",
    backupUserId: "u-unresolvable-backup",
    escalationManagerUserId: "u-unresolvable-escalation",
    createdBy: USER_A,
  });

  entityTypeC = await createEntityType(db, TENANT_A, {
    name: `resolve_oncall_fallback_ticket_${TENANT_A}_${Date.now()}`,
    plural: "tickets",
    allowCustomFields: true,
  });
  await createWorkflow(db, TENANT_A, WORKFLOW_ADMIN_A, {
    entityTypeId: entityTypeC.id,
    name: "Fallback test workflow",
    initialState: "open",
  });
});

afterAll(async () => {
  await redis.quit();
  for (const tenantId of [TENANT_A, TENANT_B]) {
    await withTenantContext(tenantId, async (tx) => {
      // Pre-existing gap, fixed here: this suite never deleted its own
      // automation_rules rows, so re-running this file during iteration
      // silently accumulated duplicate "entity.created"-triggered
      // resolve_oncall rules across runs (triggerConfig: {} matches every
      // entity.created event tenant-wide, unscoped by entity type) --
      // harmless before this spec's R5 added a comment-count assertion, but
      // it surfaced immediately once something actually counted rows.
      // workflowEvents (comments this test's own runs may have posted)
      // reference both entityInstances and workflows -- must go first, or
      // the instance/workflow deletes below hit a FK violation.
      await tx
        .delete(workflowEvents)
        .where(eq(workflowEvents.tenantId, tenantId));
      await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, tenantId));
      // automationExecutions references automationRules -- must go first.
      await tx
        .delete(automationExecutions)
        .where(eq(automationExecutions.tenantId, tenantId));
      await tx
        .delete(automationRules)
        .where(eq(automationRules.tenantId, tenantId));
      await tx
        .delete(entityInstances)
        .where(eq(entityInstances.tenantId, tenantId));
      await tx.delete(workflows).where(eq(workflows.tenantId, tenantId));
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
        fields: { title: "Test ticket", team_id: teamAId },
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
    // A team_id that only exists under TENANT_B must never resolve for
    // TENANT_A. Pre-/security-review, this fell through to
    // getActiveScheduleForTeam's own tenant scoping and landed on
    // "oncall.no_schedule" (still safe, but polluted TENANT_A's
    // coverage-gap set with TENANT_B's team id). Post-fix
    // (docs/specs/team-assign-oncall-fallback.md, /security-review finding
    // 2026-09-21), resolve-oncall.ts now validates team_id against a real,
    // same-tenant team BEFORE any of that -- a cross-tenant id is now a
    // silent no-op, same as if team_id had never been set at all: no
    // assignment, no audit row, no coverage-gap entry.
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeA.id,
        fields: { title: "Test ticket", team_id: teamBId },
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
    expect(
      auditRows.some((r) =>
        ["oncall.no_schedule", "oncall.auto_assigned"].includes(r.action),
      ),
    ).toBe(false);
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
        fields: { title: "Test ticket" },
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

    // Post-/security-review-fix (2026-09-21): a cross-tenant team_id no
    // longer even reaches getActiveScheduleForTeam -- resolve-oncall.ts's
    // own team-existence/ownership check rejects it first, silently, same
    // as the entity.created variant above.
    const auditRows = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT_A),
          eq(adminAuditLog.resourceId, instance.id),
        ),
      );
    expect(
      auditRows.some((r) =>
        ["oncall.no_schedule", "oncall.auto_assigned"].includes(r.action),
      ),
    ).toBe(false);
  });
});

describe("resolve_oncall action — workflow-admin fallback (docs/specs/team-assign-oncall-fallback.md R4/R5)", () => {
  it("falls through to the workflow admin when the team has no schedule at all", async () => {
    const { getWorkflowByEntityTypeId } =
      await import("@platform/workflow-engine");
    const wf = await getWorkflowByEntityTypeId(db, TENANT_A, entityTypeC.id);
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeC.id,
        workflowId: wf?.id,
        fields: { title: "Fallback test ticket", team_id: teamCId },
      }),
    );

    await createAutomationRule(db, TENANT_A, {
      name: "Resolve on-call on creation (no-schedule fallback)",
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
        entityTypeId: entityTypeC.id,
        fields: { team_id: teamCId },
        createdBy: USER_A,
      },
      0,
      redis,
    );

    const updated = await withTenantContext(TENANT_A, (tx) =>
      getEntity(tx, TENANT_A, instance.id),
    );
    expect(updated?.assignedTo).toBe(WORKFLOW_ADMIN_A);

    const auditRows = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT_A),
          eq(adminAuditLog.resourceId, instance.id),
        ),
      );
    const assignRow = auditRows.find(
      (r) => r.action === "oncall.auto_assigned",
    );
    expect(assignRow).toBeDefined();
    expect(
      (assignRow?.metadata as { assignedTier?: string } | null)?.assignedTier,
    ).toBe("workflow_admin");

    // Filtered to comment-typed rows only -- createEntity with a workflowId
    // also writes its own (non-comment) initial-state workflow_events rows,
    // which would otherwise inflate this count.
    const allEvents = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.instanceId, instance.id)),
    );
    const comments = allEvents.filter(
      (e) => (e.metadata as { type?: string } | null)?.type === "comment",
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]?.actorId).toBe("system");
    expect((comments[0]?.metadata as { text?: string } | null)?.text).toContain(
      "workflow admin",
    );
  });

  it("falls through to the workflow admin when the schedule's cascade is fully exhausted", async () => {
    const { getWorkflowByEntityTypeId } =
      await import("@platform/workflow-engine");
    const wf = await getWorkflowByEntityTypeId(db, TENANT_A, entityTypeC.id);
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeC.id,
        workflowId: wf?.id,
        fields: { title: "Fallback test ticket 2", team_id: teamDId },
      }),
    );

    await createAutomationRule(db, TENANT_A, {
      name: "Resolve on-call on creation (cascade-exhausted fallback)",
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
        entityTypeId: entityTypeC.id,
        fields: { team_id: teamDId },
        createdBy: USER_A,
      },
      0,
      redis,
    );

    const updated = await withTenantContext(TENANT_A, (tx) =>
      getEntity(tx, TENANT_A, instance.id),
    );
    expect(updated?.assignedTo).toBe(WORKFLOW_ADMIN_A);
  });

  // R5 §V -- the idempotency key already guarding assignment must also gate
  // the comment: a re-delivered/replayed event for the same (instanceId,
  // teamId) must never double-assign OR double-comment.
  it("does not double-post the summary comment when the same event is replayed", async () => {
    const wf = await import("@platform/workflow-engine").then((m) =>
      m.getWorkflowByEntityTypeId(db, TENANT_A, entityTypeC.id),
    );
    const instance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityTypeC.id,
        workflowId: wf?.id,
        fields: { title: "Fallback test ticket 3", team_id: teamCId },
      }),
    );

    const event = {
      version: 1 as const,
      tenantId: TENANT_A,
      eventType: "entity.created" as const,
      instanceId: instance.id,
      entityTypeId: entityTypeC.id,
      fields: { team_id: teamCId },
      createdBy: USER_A,
    };

    await createAutomationRule(db, TENANT_A, {
      name: "Resolve on-call on creation (replay guard)",
      triggerType: "entity.created",
      triggerConfig: {},
      actions: [{ type: "resolve_oncall", config: {} }],
    });

    await executeAutomationRules(db, TENANT_A, event, 0, redis);
    await executeAutomationRules(db, TENANT_A, event, 0, redis);

    const allEvents = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.instanceId, instance.id)),
    );
    const comments = allEvents.filter(
      (e) => (e.metadata as { type?: string } | null)?.type === "comment",
    );
    expect(comments).toHaveLength(1);
  });
});
