/**
 * docs/specs/retention-classes.md — the retention sweep runs under
 * withTenantContext (SET LOCAL ROLE app_user), so it can only delete what RLS
 * and the app_user grants allow. Real Postgres: proves it deletes by class,
 * protects evidence of open or recently active cases, honours a tenant hold,
 * and never touches another tenant's rows.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  workflows,
  workflowStates,
  entityInstances,
  workflowEvents,
  tenantUsageDaily,
  notifications,
  notificationRecipients,
  connectorDeliveryAttempts,
  deadLetterEvents,
  idempotencyKeys,
} from "@platform/db";

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const { sweepTenant } = await import("../../src/retention-sweep.js");
const { resolveRetentionPolicy } =
  await import("../../src/retention-policy.js");

const TENANT = "aaaaaaaa-0950-4000-a000-000000000001";
const OTHER = "bbbbbbbb-0950-4000-b000-000000000002";
const HELD = "cccccccc-0950-4000-c000-000000000003";
const ALL_TENANTS = [TENANT, OTHER, HELD];

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

interface Seeded {
  closedEvidence: string;
  closedNoiseOld: string;
  closedNoiseNew: string;
  closedCommentOld: string;
  closedCommentNew: string;
  closedTypedOld: string;
  openEvidence: string;
  activeEvidence: string;
}

async function seedTenant(tenantId: string, name: string): Promise<Seeded> {
  await db
    .insert(tenants)
    .values({ id: tenantId, name, slug: `${name}-${Date.now()}` })
    .onConflictDoNothing();
  const [et] = await db
    .insert(entityTypes)
    .values({ tenantId, name: "case", plural: "cases" })
    .returning({ id: entityTypes.id });
  const [wf] = await db
    .insert(workflows)
    .values({
      tenantId,
      entityTypeId: et!.id,
      name: "wf",
      initialState: "open",
    })
    .returning({ id: workflows.id });
  await db.insert(workflowStates).values([
    { tenantId, workflowId: wf!.id, name: "open", label: "Open" },
    {
      tenantId,
      workflowId: wf!.id,
      name: "closed",
      label: "Closed",
      isTerminal: true,
    },
  ]);
  const mkInstance = async (
    currentState: string,
    updatedAt: Date,
  ): Promise<string> => {
    const [row] = await db
      .insert(entityInstances)
      .values({
        tenantId,
        entityTypeId: et!.id,
        workflowId: wf!.id,
        currentState,
        updatedAt,
      })
      .returning({ id: entityInstances.id });
    return row!.id;
  };
  const closed = await mkInstance("closed", daysAgo(400));
  const open = await mkInstance("open", daysAgo(400));
  const active = await mkInstance("closed", daysAgo(5));

  const mkEvent = async (
    instanceId: string,
    from: string | null,
    to: string,
    age: number,
    metadata: Record<string, unknown> = {},
  ): Promise<string> => {
    const [row] = await db
      .insert(workflowEvents)
      .values({
        tenantId,
        instanceId,
        workflowId: wf!.id,
        fromState: from,
        toState: to,
        triggeredBy: "user",
        metadata,
        createdAt: daysAgo(age),
      })
      .returning({ id: workflowEvents.id });
    return row!.id;
  };

  await db.insert(tenantUsageDaily).values({
    tenantId,
    usageDate: daysAgo(200).toISOString().split("T")[0]!,
    metric: "api_calls",
    value: 1,
  });

  return {
    closedEvidence: await mkEvent(closed, "open", "closed", 400),
    closedNoiseOld: await mkEvent(closed, "closed", "closed", 100),
    closedNoiseNew: await mkEvent(closed, "closed", "closed", 10),
    closedCommentOld: await mkEvent(closed, "closed", "closed", 400, {
      type: "comment",
    }),
    closedCommentNew: await mkEvent(closed, "closed", "closed", 100, {
      type: "comment",
    }),
    closedTypedOld: await mkEvent(closed, "closed", "closed", 100, {
      type: "update",
    }),
    openEvidence: await mkEvent(open, null, "open", 400),
    activeEvidence: await mkEvent(active, "open", "closed", 400),
  };
}

async function surviving(ids: string[]): Promise<Set<string>> {
  const rows = await db
    .select({ id: workflowEvents.id })
    .from(workflowEvents)
    .where(inArray(workflowEvents.id, ids));
  return new Set(rows.map((r) => r.id));
}

const seeded: Record<string, Seeded> = {};

interface ExtraSeeded {
  oldNotification: string;
  newNotification: string;
  oldRecipient: string;
  newRecipient: string;
  oldAttempt: string;
  newAttempt: string;
  oldDeadLetter: string;
  newDeadLetter: string;
  oldKey: string;
  newKey: string;
}
const extras: Record<string, ExtraSeeded> = {};

async function seedExtras(tenantId: string): Promise<ExtraSeeded> {
  const mkNotification = async (age: number): Promise<string> => {
    const [row] = await db
      .insert(notifications)
      .values({
        tenantId,
        type: "system.error",
        title: "t",
        body: "b",
        createdAt: daysAgo(age),
      })
      .returning({ id: notifications.id });
    return row!.id;
  };
  const mkRecipient = async (notificationId: string): Promise<string> => {
    const [row] = await db
      .insert(notificationRecipients)
      .values({ notificationId, tenantId, userId: "u1" })
      .returning({ id: notificationRecipients.id });
    return row!.id;
  };
  const mkAttempt = async (age: number): Promise<string> => {
    const [row] = await db
      .insert(connectorDeliveryAttempts)
      .values({
        tenantId,
        deliveryId: crypto.randomUUID(),
        status: "success",
        attemptNumber: 1,
        createdAt: daysAgo(age),
      })
      .returning({ id: connectorDeliveryAttempts.id });
    return row!.id;
  };
  const mkDeadLetter = async (age: number): Promise<string> => {
    const [row] = await db
      .insert(deadLetterEvents)
      .values({
        tenantId,
        eventType: "x",
        payload: {},
        error: "e",
        attemptCount: 1,
        createdAt: daysAgo(age),
      })
      .returning({ id: deadLetterEvents.id });
    return row!.id;
  };
  const mkKey = async (expiredDaysAgo: number): Promise<string> => {
    const [row] = await db
      .insert(idempotencyKeys)
      .values({
        tenantId,
        apiKeyId: crypto.randomUUID(),
        actingPersonId: "p",
        idempotencyKey: crypto.randomUUID(),
        contentHash: "h",
        responseStatus: 200,
        responseBody: {},
        expiresAt: daysAgo(expiredDaysAgo),
      })
      .returning({ id: idempotencyKeys.id });
    return row!.id;
  };
  const oldNotification = await mkNotification(100);
  const newNotification = await mkNotification(10);
  return {
    oldNotification,
    newNotification,
    oldRecipient: await mkRecipient(oldNotification),
    newRecipient: await mkRecipient(newNotification),
    oldAttempt: await mkAttempt(100),
    newAttempt: await mkAttempt(10),
    oldDeadLetter: await mkDeadLetter(100),
    newDeadLetter: await mkDeadLetter(10),
    oldKey: await mkKey(100),
    newKey: await mkKey(10),
  };
}

async function extraSurvivors(e: ExtraSeeded): Promise<Set<string>> {
  const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);
  const found = [
    ...ids(
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          inArray(notifications.id, [e.oldNotification, e.newNotification]),
        ),
    ),
    ...ids(
      await db
        .select({ id: notificationRecipients.id })
        .from(notificationRecipients)
        .where(
          inArray(notificationRecipients.id, [e.oldRecipient, e.newRecipient]),
        ),
    ),
    ...ids(
      await db
        .select({ id: connectorDeliveryAttempts.id })
        .from(connectorDeliveryAttempts)
        .where(
          inArray(connectorDeliveryAttempts.id, [e.oldAttempt, e.newAttempt]),
        ),
    ),
    ...ids(
      await db
        .select({ id: deadLetterEvents.id })
        .from(deadLetterEvents)
        .where(
          inArray(deadLetterEvents.id, [e.oldDeadLetter, e.newDeadLetter]),
        ),
    ),
    ...ids(
      await db
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(inArray(idempotencyKeys.id, [e.oldKey, e.newKey])),
    ),
  ];
  return new Set(found);
}

beforeAll(async () => {
  seeded[TENANT] = await seedTenant(TENANT, "retention-a");
  seeded[OTHER] = await seedTenant(OTHER, "retention-b");
  seeded[HELD] = await seedTenant(HELD, "retention-hold");
  for (const t of ALL_TENANTS) extras[t] = await seedExtras(t);
});

afterAll(async () => {
  for (const t of ALL_TENANTS) {
    await db
      .delete(notificationRecipients)
      .where(eq(notificationRecipients.tenantId, t));
    await db.delete(notifications).where(eq(notifications.tenantId, t));
    await db
      .delete(connectorDeliveryAttempts)
      .where(eq(connectorDeliveryAttempts.tenantId, t));
    await db.delete(deadLetterEvents).where(eq(deadLetterEvents.tenantId, t));
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, t));
    await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, t));
    await db.delete(tenantUsageDaily).where(eq(tenantUsageDaily.tenantId, t));
    await db.delete(entityInstances).where(eq(entityInstances.tenantId, t));
    await db.delete(workflowStates).where(eq(workflowStates.tenantId, t));
    await db.delete(workflows).where(eq(workflows.tenantId, t));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
});

describe("retention sweep as app_user", () => {
  it("deletes by class, protects open and recently active cases, leaves other tenants alone", async () => {
    const policy = resolveRetentionPolicy({ retention_evidence_days: 365 });
    const result = await sweepTenant(TENANT, policy);

    const s = seeded[TENANT]!;
    const kept = await surviving(Object.values(s));
    expect(kept.has(s.closedNoiseOld)).toBe(false);
    expect(kept.has(s.closedNoiseNew)).toBe(true);
    expect(kept.has(s.closedCommentOld)).toBe(false);
    expect(kept.has(s.closedCommentNew)).toBe(true);
    expect(kept.has(s.closedTypedOld)).toBe(true);
    expect(kept.has(s.closedEvidence)).toBe(false);
    expect(kept.has(s.openEvidence)).toBe(true);
    expect(kept.has(s.activeEvidence)).toBe(true);
    expect(result.workflowEventsNoise).toBe(1);
    expect(result.workflowEventsComment).toBe(1);
    expect(result.workflowEventsEvidence).toBe(1);
    expect(result.tenantUsageDaily).toBe(1);

    const other = await surviving(Object.values(seeded[OTHER]!));
    expect(other.size).toBe(Object.values(seeded[OTHER]!).length);
  });

  it("sweeps notifications, delivery attempts, dead letters and expired idempotency keys past the noise window only", async () => {
    // Runs after the first test swept TENANT; the sweep is idempotent.
    const e = extras[TENANT]!;
    const kept = await extraSurvivors(e);
    expect(kept).toEqual(
      new Set([
        e.newNotification,
        e.newRecipient,
        e.newAttempt,
        e.newDeadLetter,
        e.newKey,
      ]),
    );
  });

  it("reports per-table counts for the new tables", async () => {
    const fresh = "dddddddd-0950-4000-d000-000000000004";
    await db
      .insert(tenants)
      .values({
        id: fresh,
        name: "retention-fresh",
        slug: `retention-fresh-${Date.now()}`,
      })
      .onConflictDoNothing();
    try {
      const e = await seedExtras(fresh);
      const result = await sweepTenant(fresh, resolveRetentionPolicy({}));
      expect(result.notificationRecipients).toBe(1);
      expect(result.notifications).toBe(1);
      expect(result.connectorDeliveryAttempts).toBe(1);
      expect(result.deadLetterEvents).toBe(1);
      expect(result.idempotencyKeys).toBe(1);
      expect((await extraSurvivors(e)).size).toBe(5);
    } finally {
      await db
        .delete(notificationRecipients)
        .where(eq(notificationRecipients.tenantId, fresh));
      await db.delete(notifications).where(eq(notifications.tenantId, fresh));
      await db
        .delete(connectorDeliveryAttempts)
        .where(eq(connectorDeliveryAttempts.tenantId, fresh));
      await db
        .delete(deadLetterEvents)
        .where(eq(deadLetterEvents.tenantId, fresh));
      await db
        .delete(idempotencyKeys)
        .where(eq(idempotencyKeys.tenantId, fresh));
      await db.delete(tenants).where(eq(tenants.id, fresh));
    }
  });

  it("deletes nothing for a tenant under retention hold", async () => {
    const policy = resolveRetentionPolicy({
      retention_evidence_days: 365,
      retention_hold: true,
    });
    const result = await sweepTenant(HELD, policy);
    expect(Object.values(result).every((n) => n === 0)).toBe(true);
    const kept = await surviving(Object.values(seeded[HELD]!));
    expect(kept.size).toBe(Object.values(seeded[HELD]!).length);
    expect((await extraSurvivors(extras[HELD]!)).size).toBe(10);
  });

  it("never touched another tenant's extended-table rows", async () => {
    expect((await extraSurvivors(extras[OTHER]!)).size).toBe(10);
  });

  it("with default windows keeps 400-day-old evidence even on a closed case", async () => {
    const result = await sweepTenant(OTHER, resolveRetentionPolicy({}));
    expect(result.workflowEventsEvidence).toBe(0);
    const kept = await surviving([seeded[OTHER]!.closedEvidence]);
    expect(kept.size).toBe(1);
  });
});
