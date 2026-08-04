import { eq, and } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { automationRules } from "@platform/db";
import type { ConditionTree } from "@platform/workflow-engine";
import type {
  AutomationRule,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
  TriggerType,
  ActionConfig,
} from "./types.js";
import { AutomationError } from "./types.js";
import { validateNotifyLink } from "./actions/notify.js";
import { env } from "@platform/config";

async function validateRuleActions(
  triggerType: string,
  actions?: ActionConfig[],
): Promise<void> {
  if (!actions) return;
  for (const action of actions) {
    if (action.type === "notify") {
      const link = action.config.payload?.link;
      if (typeof link === "string") {
        await validateNotifyLink(link, env.SSRF_BLOCK_CIDRS);
      }
    } else if (action.type === "webhook") {
      if (triggerType === "entity.created") {
        const config = action.config;
        if (
          config.includePayload &&
          (!config.sendFields || config.sendFields.length === 0)
        ) {
          throw new AutomationError("INVALID_EVENT_PAYLOAD", {
            reason:
              "sendFields must be configured and non-empty when includePayload is true for entity.created trigger",
          });
        }
      }
    }
  }
}

function rowToRule(r: typeof automationRules.$inferSelect): AutomationRule {
  return {
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    isEnabled: r.isEnabled,
    triggerType: r.triggerType as TriggerType,
    triggerConfig: r.triggerConfig as Record<string, unknown>,
    // Drizzle types jsonb as unknown; cast once here at the DB boundary.
    // The shape is guaranteed by ConditionTreeSchema validation at write time.
    conditions: (r.conditions ?? null) as ConditionTree | null,
    actions: r.actions as ActionConfig[],
    priority: r.priority,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function createAutomationRule(
  db: DbOrTx,
  tenantId: string,
  input: CreateAutomationRuleInput,
): Promise<AutomationRule> {
  await validateRuleActions(input.triggerType, input.actions);
  const [row] = await db
    .insert(automationRules)
    .values({
      tenantId,
      name: input.name,
      triggerType: input.triggerType,
      triggerConfig: input.triggerConfig,
      conditions: input.conditions ?? null,
      actions: input.actions,
      isEnabled: input.isEnabled ?? true,
      priority: input.priority ?? 0,
    })
    .returning();

  if (!row) throw new AutomationError("RULE_CREATE_FAILED");
  return rowToRule(row);
}

export async function getAutomationRule(
  db: DbOrTx,
  tenantId: string,
  id: string,
): Promise<AutomationRule> {
  const [row] = await db
    .select()
    .from(automationRules)
    .where(
      and(eq(automationRules.id, id), eq(automationRules.tenantId, tenantId)),
    )
    .limit(1);

  if (!row) throw new AutomationError("RULE_NOT_FOUND", { id });
  return rowToRule(row);
}

export async function listAutomationRules(
  db: DbOrTx,
  tenantId: string,
  filter?: {
    triggerType?: TriggerType;
    isEnabled?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<AutomationRule[]> {
  const conditions = [eq(automationRules.tenantId, tenantId)];

  if (filter?.triggerType !== undefined) {
    conditions.push(eq(automationRules.triggerType, filter.triggerType));
  }
  if (filter?.isEnabled !== undefined) {
    conditions.push(eq(automationRules.isEnabled, filter.isEnabled));
  }

  const limit = filter?.limit ?? 500;
  const offset = filter?.offset ?? 0;

  const rows = await db
    .select()
    .from(automationRules)
    .where(and(...conditions))
    .orderBy(automationRules.priority, automationRules.createdAt)
    .limit(limit)
    .offset(offset);

  return rows.map(rowToRule);
}

export async function updateAutomationRule(
  db: DbOrTx,
  tenantId: string,
  id: string,
  input: UpdateAutomationRuleInput,
): Promise<AutomationRule> {
  const existing = await getAutomationRule(db, tenantId, id);
  const triggerType = input.triggerType ?? existing.triggerType;
  const actions = input.actions ?? existing.actions;
  await validateRuleActions(triggerType, actions);
  const now = new Date();
  const updates: Partial<typeof automationRules.$inferInsert> = {
    updatedAt: now,
  };

  if (input.name !== undefined) updates.name = input.name;
  if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;
  if (input.triggerType !== undefined) updates.triggerType = input.triggerType;
  if (input.triggerConfig !== undefined)
    updates.triggerConfig = input.triggerConfig;
  if (input.conditions !== undefined) updates.conditions = input.conditions;
  if (input.actions !== undefined) updates.actions = input.actions;
  if (input.priority !== undefined) updates.priority = input.priority;

  const [row] = await db
    .update(automationRules)
    .set(updates)
    .where(
      and(eq(automationRules.id, id), eq(automationRules.tenantId, tenantId)),
    )
    .returning();

  if (!row) throw new AutomationError("RULE_NOT_FOUND", { id });
  return rowToRule(row);
}

export async function deleteAutomationRule(
  db: DbOrTx,
  tenantId: string,
  id: string,
): Promise<void> {
  const result = await db
    .delete(automationRules)
    .where(
      and(eq(automationRules.id, id), eq(automationRules.tenantId, tenantId)),
    )
    .returning({ id: automationRules.id });

  if (result.length === 0) throw new AutomationError("RULE_NOT_FOUND", { id });
}
