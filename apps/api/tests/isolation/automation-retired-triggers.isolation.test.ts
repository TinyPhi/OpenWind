/**
 * #684 part 2: migration 0132 converts rules stored on trigger types nothing
 * emits (workflow.entered_state, field.changed) to the events that do fire,
 * and disables schedule.cron / connector.event rules. Each tenant's rows are
 * converted on their own terms, other rules are untouched, and a converted
 * "field changed" rule then fires through the real executor only when its
 * field changes.
 *
 * Real Postgres and Redis. Old-shape rules are inserted directly, because the
 * API no longer accepts these types.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  tenants,
  automationRules,
  automationExecutions,
  withTenantContext,
} from "@platform/db";
import { env } from "@platform/config";
import { executeAutomationRules } from "@platform/automation-engine";

const TENANT = "dddddddd-0684-4000-d000-000000000001";
const OTHER = "dddddddd-0684-4000-d000-000000000002";
const WORKFLOW_ID = "eeeeeeee-0684-4000-e000-000000000001";
const TYPE_ID = "eeeeeeee-0684-4000-e000-000000000002";

const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../../packages/db/migrations/0132_automation_rules_retire_inert_triggers.sql",
  ),
  "utf8",
);

let redis: Redis;
const ids: Record<string, string> = {};

async function seedRule(
  key: string,
  tenantId: string,
  triggerType: string,
  triggerConfig: Record<string, unknown>,
): Promise<void> {
  const [row] = await db
    .insert(automationRules)
    .values({
      tenantId,
      name: `#684 ${key}`,
      isEnabled: true,
      triggerType,
      triggerConfig,
      actions: [],
    })
    .returning({ id: automationRules.id });
  if (!row) throw new Error(`seed ${key} failed`);
  ids[key] = row.id;
}

async function ruleRow(key: string): Promise<{
  triggerType: string;
  triggerConfig: unknown;
  isEnabled: boolean;
  updatedAt: Date;
}> {
  const [row] = await db
    .select({
      triggerType: automationRules.triggerType,
      triggerConfig: automationRules.triggerConfig,
      isEnabled: automationRules.isEnabled,
      updatedAt: automationRules.updatedAt,
    })
    .from(automationRules)
    .where(eq(automationRules.id, ids[key] ?? ""));
  if (!row) throw new Error(`rule ${key} missing`);
  return row;
}

async function executionsFor(
  tenantId: string,
  ruleKey: string,
): Promise<number> {
  const rows = await db
    .select({ id: automationExecutions.id })
    .from(automationExecutions)
    .where(
      and(
        eq(automationExecutions.tenantId, tenantId),
        eq(automationExecutions.ruleId, ids[ruleKey] ?? ""),
      ),
    );
  return rows.length;
}

async function fireUpdate(
  tenantId: string,
  changed: Record<string, { old: unknown; new: unknown }>,
): Promise<void> {
  await withTenantContext(tenantId, (tx) =>
    executeAutomationRules(
      tx,
      tenantId,
      {
        eventType: "entity.updated",
        version: 1,
        tenantId,
        instanceId: randomUUID(),
        entityTypeId: TYPE_ID,
        actorId: null,
        changed,
      },
      0,
      redis,
    ),
  );
}

let untouchedBefore: Date;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  for (const id of [TENANT, OTHER]) {
    await db
      .insert(tenants)
      .values({ id, name: `#684 ${id}`, slug: `retired-triggers-${id}` })
      .onConflictDoNothing();
  }

  await seedRule("enteredState", TENANT, "workflow.entered_state", {
    workflowId: WORKFLOW_ID,
    state: "approved",
    toState: "",
  });
  await seedRule("fieldName", TENANT, "field.changed", {
    entityTypeId: TYPE_ID,
    fieldName: "status",
  });
  await seedRule("anyField", TENANT, "field.changed", {
    entityTypeId: TYPE_ID,
    field: "",
    fieldName: "",
  });
  await seedRule("untouched", TENANT, "entity.created", {
    entityTypeId: TYPE_ID,
  });
  await seedRule("cron", OTHER, "schedule.cron", { cron: "0 9 * * *" });
  await seedRule("connector", OTHER, "connector.event", { source: "tally" });
  await seedRule("otherField", OTHER, "field.changed", {
    entityTypeId: TYPE_ID,
    field: "status",
  });
  untouchedBefore = (await ruleRow("untouched")).updatedAt;

  await db.execute(sql.raw(MIGRATION));
});

afterAll(async () => {
  await redis.quit();
  for (const id of [TENANT, OTHER]) {
    await db
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, id));
    await db.delete(automationRules).where(eq(automationRules.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
});

describe("migration 0132 — retired trigger types (#684)", () => {
  it("turns a state-entered rule into a transition on toState, reading the old state key", async () => {
    expect(await ruleRow("enteredState")).toMatchObject({
      triggerType: "workflow.transitioned",
      triggerConfig: { workflowId: WORKFLOW_ID, toState: "approved" },
      isEnabled: true,
    });
  });

  it("turns a field-changed rule into an entity update on field, reading the old fieldName key", async () => {
    expect(await ruleRow("fieldName")).toMatchObject({
      triggerType: "entity.updated",
      triggerConfig: { entityTypeId: TYPE_ID, field: "status" },
      isEnabled: true,
    });
  });

  it("drops empty-string keys, leaving an any-field update", async () => {
    const row = await ruleRow("anyField");
    expect(row.triggerType).toBe("entity.updated");
    expect(row.triggerConfig).toEqual({ entityTypeId: TYPE_ID });
  });

  it("disables cron and connector rules but keeps their definitions", async () => {
    for (const key of ["cron", "connector"]) {
      const row = await ruleRow(key);
      expect(row.isEnabled).toBe(false);
      expect(["schedule.cron", "connector.event"]).toContain(row.triggerType);
    }
    expect((await ruleRow("cron")).triggerConfig).toEqual({
      cron: "0 9 * * *",
    });
  });

  it("converts each tenant's rows and leaves supported rules untouched", async () => {
    expect((await ruleRow("otherField")).triggerType).toBe("entity.updated");
    const untouched = await ruleRow("untouched");
    expect(untouched.triggerType).toBe("entity.created");
    expect(untouched.updatedAt).toEqual(untouchedBefore);
  });

  it("leaves no rule on a retired type enabled", async () => {
    const live = await db
      .select({ id: automationRules.id })
      .from(automationRules)
      .where(
        and(
          inArray(automationRules.tenantId, [TENANT, OTHER]),
          inArray(automationRules.triggerType, [
            "workflow.entered_state",
            "field.changed",
            "schedule.cron",
            "connector.event",
          ]),
          eq(automationRules.isEnabled, true),
        ),
      );
    expect(live).toEqual([]);
  });

  it("is a no-op when applied a second time", async () => {
    const before = await ruleRow("fieldName");
    await db.execute(sql.raw(MIGRATION));
    expect(await ruleRow("fieldName")).toMatchObject({
      triggerType: before.triggerType,
      triggerConfig: before.triggerConfig,
    });
  });
});

describe("a converted field-changed rule fires through the executor", () => {
  it("fires when its field changes and not when another field does", async () => {
    await fireUpdate(TENANT, { priority: { old: "low", new: "high" } });
    expect(await executionsFor(TENANT, "fieldName")).toBe(0);

    await fireUpdate(TENANT, { status: { old: "open", new: "done" } });
    expect(await executionsFor(TENANT, "fieldName")).toBe(1);
  });

  it("fires the any-field rule on every update", async () => {
    expect(await executionsFor(TENANT, "anyField")).toBe(2);
  });

  it("never fires one tenant's rule for another tenant's event", async () => {
    expect(await executionsFor(OTHER, "otherField")).toBe(0);
    await fireUpdate(OTHER, { status: { old: "open", new: "done" } });
    expect(await executionsFor(OTHER, "otherField")).toBe(1);
    expect(await executionsFor(TENANT, "fieldName")).toBe(1);
  });
});
