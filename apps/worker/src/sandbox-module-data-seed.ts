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
 * Every query runs inside the sandbox tenant's RLS context (withTenantContext). It used to
 * run on plain `db`; on the compose app_user connection RLS then rejected the very first
 * entity_types lookup, so every module's data seed failed and sandboxes arrived empty.
 *
 * Each record gets what a real ticket has: a title (the one required custom field), a due
 * date, a severity, an assignee from the sandbox's seeded accounts and a remark -- plus a
 * value for every other non-reference field, so the create form's Others tab isn't blank.
 *
 * Per-module target states/transition-path table below is derived directly from each
 * module's seed SQL (modules/<slug>/seed/*.sql) -- stable schema, not worth re-deriving
 * from the DB at runtime. None of the 7 core modules' transitions have requiresFields or
 * non-null conditions; only helpdesk gates on allowedRoles (admin/agent) -- actorRoles
 * below is a superset covering every core module's gates.
 */
import { and, eq, gte, isNull } from "drizzle-orm";
import {
  withTenantContext,
  entityTypes,
  entityFields,
  workflows,
  workflowTransitions,
  outboxEvents,
} from "@platform/db";
import type { DbOrTx } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { executeTransition } from "@platform/workflow-engine";
import { logger } from "@platform/logger";

const SEED_ACTOR_ROLES = ["admin", "agent", "user"];
const SEED_COMMENT = "Seeded by platform admin sandbox provisioning";
const SEED_SEVERITIES = ["low", "medium", "high", "critical"] as const;
// Filled by other means or not meaningful as dummy data: references need a real target,
// and team_id is written only by the create form's User/Team assign toggle.
const SKIPPED_FIELD_TYPES = new Set(["entity_ref", "user_ref", "file"]);
const SKIPPED_FIELD_NAMES = new Set(["title", "team_id"]);
const DAY_MS = 24 * 60 * 60 * 1000;

interface ModuleSeedPlan {
  slug: string;
  entityTypeName: string;
  /** Each entry is one record's hop sequence of toState values from the workflow's
   * initial state -- `[]` means "leave it at the initial state". */
  recordPaths: string[][];
  /** One realistic title per record, same length as recordPaths. */
  titles: string[];
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
    titles: [
      "Cannot log in after password reset",
      "Invoice PDF shows the wrong billing address",
      "Export to CSV times out for large reports",
      "Request to add two new team members",
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
    titles: [
      "Northwind Traders: initial enquiry",
      "Brightwater Logistics: annual platform licence",
      "Halcyon Foods: support plan upgrade",
      "Kestrel Manufacturing: multi-site rollout",
      "Acme Ltd: renewal and expansion",
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
    titles: [
      "Annual leave: family trip",
      "Sick leave: two days",
      "Annual leave: year-end break",
      "Unpaid leave: personal matters",
      "Annual leave: conference week",
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
    titles: [
      "Client visit: train tickets",
      "Team lunch with new hires",
      "Conference registration fee",
      "Taxi to the airport",
      "Office supplies for the new desk",
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
    titles: [
      "Draft the Q4 roadmap",
      "Set up the staging environment",
      "Write onboarding guide for new users",
      "Review the analytics dashboard design",
      "Migrate customer list to the new CRM",
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
    titles: [
      "INV-1001: Brightwater Logistics consulting, October",
      "INV-1002: Halcyon Foods support retainer",
      "INV-1003: Northwind training workshop",
      "INV-1004: Kestrel Manufacturing licence renewal",
      "INV-1005: Acme Ltd implementation",
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
    titles: [
      "Laptops for the new support team",
      "Annual design tool licences",
      "Standing desks for the office",
      "Cloud backup storage upgrade",
      "Conference room display screens",
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
  assigneeIds: string[],
): Promise<{ seeded: number }> {
  const plan = MODULE_SEED_PLANS.find((p) => p.slug === slug);
  if (!plan) return { seeded: 0 };

  return withTenantContext(tenantId, (tx) =>
    seedModuleDataInTx(tx, tenantId, slug, plan, assigneeIds),
  );
}

async function seedModuleDataInTx(
  tx: DbOrTx,
  tenantId: string,
  slug: string,
  plan: ModuleSeedPlan,
  assigneeIds: string[],
): Promise<{ seeded: number }> {
  const [entityType] = await tx
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

  const [workflow] = await tx
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

  const fieldRows = await tx
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
      ),
    );
  const valueFields = fieldRows.filter(
    (f) =>
      !SKIPPED_FIELD_TYPES.has(f.fieldType) && !SKIPPED_FIELD_NAMES.has(f.name),
  );

  const transitionRows = await tx
    .select()
    .from(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflow.id));
  const transitionLookup = new Map<string, (typeof transitionRows)[number]>();
  for (const t of transitionRows) {
    transitionLookup.set(`${t.fromState}->${t.toState}`, t);
  }

  let seeded = 0;
  for (let i = 0; i < plan.recordPaths.length; i++) {
    const fields: Record<string, unknown> = {
      title: plan.titles[i] ?? `${plan.entityTypeName} ${i + 1}`,
    };
    for (const field of valueFields) {
      fields[field.name] = defaultValueForField(
        field.fieldType,
        field.config,
        i,
      );
    }

    const instance = await createEntity(tx, tenantId, {
      entityTypeId: entityType.id,
      workflowId: workflow.id,
      fields,
      actorId: "system",
      actorType: "system",
      dueDate: new Date(Date.now() + (i + 1) * 3 * DAY_MS).toISOString(),
      severity: SEED_SEVERITIES[i % SEED_SEVERITIES.length],
      remark: SEED_COMMENT,
      ...(assigneeIds.length > 0
        ? { assignedTo: assigneeIds[i % assigneeIds.length] }
        : {}),
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
      await executeTransition(tx, tenantId, {
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
  /** Zitadel user ids of the sandbox's seeded accounts; records are assigned round-robin. */
  assigneeIds: string[] = [],
): Promise<void> {
  const seedStartedAt = new Date();

  for (const slug of moduleSlugs) {
    try {
      await seedModuleData(tenantId, slug, assigneeIds);
    } catch (err) {
      logger.error(
        { err, tenantId, slug },
        "sandbox module data seed: failed for module — continuing with remaining modules",
      );
    }
  }

  // Runs as app_user inside the tenant context, like the rest of this file: migration 0019
  // grants app_user SELECT/INSERT/UPDATE/DELETE on outbox_events, and the table's tenant RLS
  // policy (outbox_events_tenant_isolation) admits rows of the tenant set here. A refusal
  // throws rather than updating nothing, so it cannot fail silently.
  await withTenantContext(tenantId, (tx) =>
    tx
      .update(outboxEvents)
      .set({ deliveredAt: new Date(), notifiedDeliveredAt: new Date() })
      .where(
        and(
          eq(outboxEvents.tenantId, tenantId),
          isNull(outboxEvents.deliveredAt),
          gte(outboxEvents.createdAt, seedStartedAt),
        ),
      ),
  );
}
