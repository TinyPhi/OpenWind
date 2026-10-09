/**
 * sandbox-module-data-seed.ts
 *
 * T9 (docs/specs/multi-org-sandbox.md Phase 2) — seeds a small, fixed set of real records
 * per core module, spread across that module's actual workflow states, for a
 * freshly-provisioned sandbox tenant (after sandbox-module-install.ts has installed the
 * module's schema/workflow/view-config/automation-rule seed SQL, which creates zero data
 * rows on its own).
 *
 * Records are driven through REAL executeTransition calls (never a raw currentState
 * write) so each one's transition/event history looks like it happened through normal
 * use, not a seed script. actorId/actorType "system" is this codebase's established
 * non-human-actor convention (see packages/automation-engine/src/actions/create-entity.ts,
 * resolve-oncall.ts, dispatch-severity-notification.ts).
 *
 * Security review: executeTransition and createEntity unconditionally write to
 * `outbox_events` regardless of triggeredBy (automation consumption is a separate,
 * async step per docs/specs/outbox-automation-idempotent-consumption.md) -- left alone,
 * a real automation worker could pick these up and fire actual notifications/webhooks
 * against fabricated demo data. seedAllModulesData marks every outbox row this seeding
 * produces as delivered immediately, mirroring the outbox-row-supersession pattern
 * already used by packages/workflow-engine/src/engine.ts's rescheduleDueDate.
 *
 * Per-module target states/transition-path table below is derived directly from each
 * module's seed SQL (modules/<slug>/seed/*.sql) -- stable schema, not worth re-deriving
 * from the DB at runtime. None of the 7 core modules' transitions have requiresFields or
 * non-null conditions; only helpdesk gates on allowedRoles (admin/agent) -- actorRoles
 * below is a superset covering every core module's gates.
 */
import { and, eq, gte, isNull } from "drizzle-orm";
import {
  db,
  entityTypes,
  entityFields,
  workflows,
  workflowTransitions,
  outboxEvents,
} from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { executeTransition } from "@platform/workflow-engine";
import { logger } from "@platform/logger";

const SEED_ACTOR_ROLES = ["admin", "agent", "user"];
const SEED_COMMENT = "Seeded by platform admin sandbox provisioning";

interface ModuleSeedPlan {
  slug: string;
  entityTypeName: string;
  /** Each entry is one record's hop sequence of toState values from the workflow's
   * initial state -- `[]` means "leave it at the initial state". */
  recordPaths: string[][];
}

// Core-module coverage only (ADR-005 category='core') -- tender/vendor-approval are
// 'optional' and not auto-installed for sandboxes (installCoreModulesForSandbox mirrors
// ModuleService.installCoreModules' own scope).
const MODULE_SEED_PLANS: ModuleSeedPlan[] = [
  {
    slug: "helpdesk",
    entityTypeName: "ticket",
    recordPaths: [
      [],
      ["in_progress"],
      ["in_progress", "pending"],
      ["in_progress", "resolved"],
    ],
  },
  {
    slug: "crm",
    entityTypeName: "Deal",
    recordPaths: [
      [],
      ["qualified"],
      ["qualified", "proposal"],
      ["qualified", "proposal", "negotiation"],
      ["qualified", "proposal", "negotiation", "won"],
    ],
  },
  {
    slug: "hrms",
    entityTypeName: "Leave Request",
    recordPaths: [
      [],
      ["under_review"],
      ["under_review", "approved"],
      ["under_review", "rejected"],
      ["cancelled"],
    ],
  },
  {
    slug: "reimbursements",
    entityTypeName: "Expense Claim",
    recordPaths: [
      [],
      ["submitted"],
      ["submitted", "approved"],
      ["submitted", "rejected"],
      ["submitted", "approved", "paid"],
    ],
  },
  {
    slug: "projects",
    entityTypeName: "Task",
    recordPaths: [
      [],
      ["todo"],
      ["todo", "in_progress"],
      ["todo", "in_progress", "in_review"],
      ["todo", "in_progress", "in_review", "done"],
    ],
  },
  {
    slug: "invoicing",
    entityTypeName: "Invoice",
    recordPaths: [
      [],
      ["sent"],
      ["sent", "viewed"],
      ["sent", "overdue"],
      ["sent", "viewed", "paid"],
    ],
  },
  {
    slug: "procurement",
    entityTypeName: "Purchase Order",
    recordPaths: [
      [],
      ["under_review"],
      ["under_review", "approved"],
      ["under_review", "approved", "ordered"],
      ["under_review", "approved", "ordered", "received"],
    ],
  },
];

/**
 * Type-appropriate dummy value per field_type, matching packages/entity-engine/src/
 * validation/schema-builder.ts's buildFieldSchema exactly (currency is {amount,currency},
 * date is a plain YYYY-MM-DD string, enum/select picks the first option). None of the 7
 * core modules have a REQUIRED entity_ref/user_ref/file field (verified against each
 * module's seed SQL), so those are deliberately not handled here.
 */
function defaultValueForField(
  fieldType: string,
  config: unknown,
  seedIndex: number,
): unknown {
  const cfg = (config ?? {}) as Record<string, unknown>;
  switch (fieldType) {
    case "text":
      return `Sandbox seed ${seedIndex + 1}`;
    case "longtext":
      return "Seeded automatically for sandbox demo purposes.";
    case "number": {
      const min = typeof cfg["min"] === "number" ? cfg["min"] : 0;
      const max =
        typeof cfg["max"] === "number" ? (cfg["max"] as number) : min + 100;
      return Math.min(max, Math.max(min, 10));
    }
    case "currency": {
      const allowed = cfg["allowedCurrencies"];
      const currency =
        Array.isArray(allowed) && allowed.length > 0
          ? String(allowed[0])
          : "USD";
      return { amount: 100 + seedIndex * 10, currency };
    }
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "datetime":
      return new Date().toISOString();
    case "boolean":
      return false;
    case "enum":
    case "select": {
      const options = cfg["options"];
      if (Array.isArray(options) && options.length > 0) {
        const first = options[0] as unknown;
        return typeof first === "string"
          ? first
          : ((first as { value?: unknown }).value ?? "");
      }
      return "";
    }
    case "multi_enum": {
      const options = cfg["options"];
      if (Array.isArray(options) && options.length > 0) {
        const first = options[0] as unknown;
        const value =
          typeof first === "string"
            ? first
            : ((first as { value?: unknown }).value ?? "");
        return [value];
      }
      return [];
    }
    default:
      return `seed-${seedIndex}`;
  }
}

async function seedModuleData(
  tenantId: string,
  slug: string,
): Promise<{ seeded: number }> {
  const plan = MODULE_SEED_PLANS.find((p) => p.slug === slug);
  if (!plan) return { seeded: 0 };

  const [entityType] = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(
      and(
        eq(entityTypes.tenantId, tenantId),
        eq(entityTypes.name, plan.entityTypeName),
      ),
    )
    .limit(1);
  if (!entityType) {
    logger.warn(
      { tenantId, slug },
      "sandbox module data seed: entity type not found — skipping",
    );
    return { seeded: 0 };
  }

  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        eq(workflows.entityTypeId, entityType.id),
      ),
    )
    .limit(1);
  if (!workflow) {
    logger.warn(
      { tenantId, slug },
      "sandbox module data seed: workflow not found — skipping",
    );
    return { seeded: 0 };
  }

  const requiredFields = await db
    .select({
      name: entityFields.name,
      fieldType: entityFields.fieldType,
      config: entityFields.config,
    })
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityType.id),
        eq(entityFields.tenantId, tenantId),
        eq(entityFields.isRequired, true),
      ),
    );

  const transitionRows = await db
    .select()
    .from(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflow.id));
  const transitionLookup = new Map<string, (typeof transitionRows)[number]>();
  for (const t of transitionRows) {
    transitionLookup.set(`${t.fromState}->${t.toState}`, t);
  }

  let seeded = 0;
  for (let i = 0; i < plan.recordPaths.length; i++) {
    const fields: Record<string, unknown> = {};
    for (const field of requiredFields) {
      fields[field.name] = defaultValueForField(
        field.fieldType,
        field.config,
        i,
      );
    }

    const instance = await createEntity(db, tenantId, {
      entityTypeId: entityType.id,
      workflowId: workflow.id,
      fields,
      actorId: "system",
      actorType: "system",
    });

    let currentState = instance.currentState;
    for (const toState of plan.recordPaths[i] ?? []) {
      const transition = transitionLookup.get(`${currentState}->${toState}`);
      if (!transition) {
        logger.warn(
          { tenantId, slug, fromState: currentState, toState },
          "sandbox module data seed: no transition found for this hop — stopping this record's path early",
        );
        break;
      }
      await executeTransition(db, tenantId, {
        instanceId: instance.id,
        transitionId: transition.id,
        actorId: "system",
        actorRoles: SEED_ACTOR_ROLES,
        comment: SEED_COMMENT,
        triggeredBy: "system",
      });
      currentState = toState;
    }
    seeded++;
  }

  return { seeded };
}

/**
 * Seeds data for every given module slug, then suppresses automation side-effects from
 * firing against it (see module doc comment). One module's failure doesn't block the
 * rest -- same independent-attempt reasoning as installCoreModulesForSandbox.
 */
export async function seedAllModulesData(
  tenantId: string,
  moduleSlugs: string[],
): Promise<void> {
  const seedStartedAt = new Date();

  for (const slug of moduleSlugs) {
    try {
      await seedModuleData(tenantId, slug);
    } catch (err) {
      logger.error(
        { err, tenantId, slug },
        "sandbox module data seed: failed for module — continuing with remaining modules",
      );
    }
  }

  await db
    .update(outboxEvents)
    .set({ deliveredAt: new Date(), notifiedDeliveredAt: new Date() })
    .where(
      and(
        eq(outboxEvents.tenantId, tenantId),
        isNull(outboxEvents.deliveredAt),
        gte(outboxEvents.createdAt, seedStartedAt),
      ),
    );
}
