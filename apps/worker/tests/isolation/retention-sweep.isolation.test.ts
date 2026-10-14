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

beforeAll(async () => {
  seeded[TENANT] = await seedTenant(TENANT, "retention-a");
  seeded[OTHER] = await seedTenant(OTHER, "retention-b");
  seeded[HELD] = await seedTenant(HELD, "retention-hold");
});

afterAll(async () => {
  for (const t of ALL_TENANTS) {
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

  it("deletes nothing for a tenant under retention hold", async () => {
    const policy = resolveRetentionPolicy({
      retention_evidence_days: 365,
      retention_hold: true,
    });
    const result = await sweepTenant(HELD, policy);
    expect(Object.values(result).every((n) => n === 0)).toBe(true);
    const kept = await surviving(Object.values(seeded[HELD]!));
    expect(kept.size).toBe(Object.values(seeded[HELD]!).length);
  });

  it("with default windows keeps 400-day-old evidence even on a closed case", async () => {
    const result = await sweepTenant(OTHER, resolveRetentionPolicy({}));
    expect(result.workflowEventsEvidence).toBe(0);
    const kept = await surviving([seeded[OTHER]!.closedEvidence]);
    expect(kept.size).toBe(1);
  });
});
