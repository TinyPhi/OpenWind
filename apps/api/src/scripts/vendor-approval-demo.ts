/**
 * Sets up the vendor-approval module on a tenant with realistic records at
 * every stage (docs/specs/vendor-approval.md R7). Runs inside ow-backend so it
 * shares the API's DB, Redis and file storage:
 *
 *   docker compose exec ow-backend pnpm exec tsx apps/api/src/scripts/vendor-approval-demo.ts \
 *     [--tenant <uuid>] [--notify it_security=<userId>] [--notify legal=<userId>] \
 *     [--notify finance_approver=<userId>]
 *
 * Idempotent: the module install is a no-op once installed, and fixtures are
 * keyed on external_ref, so re-running never duplicates vendors.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { env } from "@platform/config";
import {
  withTenantContext,
  entityTypes,
  entityInstances,
  workflows,
  workflowTransitions,
  automationRules,
} from "@platform/db";
import { createEntity, updateEntity } from "@platform/entity-engine";
import { executeTransition } from "@platform/workflow-engine";
import { saveUpload } from "@platform/files";
import { logger } from "@platform/logger";
import { ModuleService, getWorkspaceRoot } from "../services/module-service.js";
import { connection as redis } from "../lib/redis.js";
import {
  VendorPayloadSchema,
  mapVendorPayload,
  type VendorFields,
} from "./vendor-approval-payload.js";
import {
  REVIEW_STATES,
  REJECTORS,
  rejectionStageFor,
  type ReviewState,
} from "./vendor-approval-rejection.js";

const MODULE_SLUG = "vendor-approval";
const ACTOR_ID = "vendor-approval-demo-script";
const FALLBACK_DEV_TENANT_ID = "00000000-0000-0000-0000-000000000001";

const STATES = [
  "draft",
  "it_security_review",
  "legal_review",
  "pending_final_approval",
  "approved",
  "rejected",
] as const;

const FixtureSchema = z.array(
  z.object({
    advanceTo: z.enum(STATES),
    // Only meaningful with advanceTo "rejected"; defaults to the first review stage.
    rejectAt: z.enum(REVIEW_STATES).optional(),
    payload: VendorPayloadSchema,
  }),
);

const DEPARTMENT_RULES: Record<string, string> = {
  it_security:
    "Vendor approval: notify IT Security on entry to it_security_review",
  legal: "Vendor approval: notify Legal on entry to legal_review",
  finance_approver:
    "Vendor approval: notify Finance on entry to pending_final_approval",
};

// Happy path, one hop per department. "rejected" leaves this path after the
// first review stage.
const APPROVAL_PATH: Array<{ from: string; to: string; roles: string[] }> = [
  { from: "draft", to: "it_security_review", roles: ["agent"] },
  { from: "it_security_review", to: "legal_review", roles: ["it_security"] },
  { from: "legal_review", to: "pending_final_approval", roles: ["legal"] },
  {
    from: "pending_final_approval",
    to: "approved",
    roles: ["finance_approver"],
  },
];

const ArgsSchema = z.object({
  tenant: z.string().uuid(),
  notify: z.record(
    z.enum(["it_security", "legal", "finance_approver"]),
    z.string().min(1),
  ),
});

function parseArgs(argv: string[]): z.infer<typeof ArgsSchema> {
  let tenant = env.DEV_TENANT_ID ?? FALLBACK_DEV_TENANT_ID;
  const notify: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--tenant" && value) {
      tenant = value;
      i++;
    } else if (flag === "--notify" && value) {
      const [role, userId] = value.split("=", 2);
      if (role && userId) notify[role] = userId;
      i++;
    } else {
      throw new Error(`Unrecognised argument: ${String(flag)}`);
    }
  }
  return ArgsSchema.parse({ tenant, notify });
}

async function loadConfig(tenantId: string): Promise<{
  entityTypeId: string;
  workflowId: string;
  transitionIds: Map<string, string>;
}> {
  return withTenantContext(tenantId, async (tx) => {
    const [et] = await tx
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(
        and(eq(entityTypes.tenantId, tenantId), eq(entityTypes.name, "vendor")),
      );
    if (!et) throw new Error("vendor entity type missing after install");
    const [wf] = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          eq(workflows.entityTypeId, et.id),
        ),
      );
    if (!wf) throw new Error("vendor workflow missing after install");
    const rows = await tx
      .select()
      .from(workflowTransitions)
      .where(
        and(
          eq(workflowTransitions.tenantId, tenantId),
          eq(workflowTransitions.workflowId, wf.id),
        ),
      );
    return {
      entityTypeId: et.id,
      workflowId: wf.id,
      transitionIds: new Map(
        rows.map((t) => [`${t.fromState}->${t.toState}`, t.id]),
      ),
    };
  });
}

async function wireNotifications(
  tenantId: string,
  notify: Record<string, string>,
): Promise<void> {
  for (const [role, userId] of Object.entries(notify)) {
    const name = DEPARTMENT_RULES[role];
    if (!name) continue;
    const ruleId = await withTenantContext(tenantId, async (tx) => {
      const [rule] = await tx
        .select()
        .from(automationRules)
        .where(
          and(
            eq(automationRules.tenantId, tenantId),
            eq(automationRules.name, name),
          ),
        );
      if (!rule) throw new Error(`notify rule not found: ${name}`);
      // jsonb column — shape fixed by modules/vendor-approval/seed/003_automation_rules.sql.
      const actions = rule.actions as Array<{
        type: string;
        config: Record<string, unknown>;
      }>;
      await tx
        .update(automationRules)
        .set({
          isEnabled: true,
          actions: actions.map((a) =>
            a.type === "notify"
              ? { ...a, config: { ...a.config, recipientId: userId } }
              : a,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(automationRules.id, rule.id),
            eq(automationRules.tenantId, tenantId),
          ),
        );
      return rule.id;
    });
    logger.info(
      { tenantId, ruleId, role },
      "Vendor approval notify rule enabled",
    );
  }
}

async function attachFile(
  tenantId: string,
  instanceId: string,
  field: "security_questionnaire" | "contract_draft",
  vendorName: string,
): Promise<void> {
  const body = Buffer.from(
    `${field === "security_questionnaire" ? "Security questionnaire" : "Draft contract"} — ${vendorName}\n` +
      "Synthetic document generated by vendor-approval-demo.ts.\n",
  );
  const { fileId } = await withTenantContext(tenantId, (tx) =>
    saveUpload(
      tx,
      redis,
      tenantId,
      ACTOR_ID,
      MODULE_SLUG,
      instanceId,
      `${field}.txt`,
      "text/plain",
      body,
    ),
  );
  await withTenantContext(tenantId, (tx) =>
    updateEntity(tx, tenantId, instanceId, {
      fields: { [field]: fileId },
      actorId: ACTOR_ID,
      actorType: "system",
    }),
  );
}

async function step(
  tenantId: string,
  instanceId: string,
  transitionId: string | undefined,
  roles: string[],
  comment?: string,
): Promise<void> {
  if (!transitionId) throw new Error("transition missing from seeded workflow");
  await withTenantContext(tenantId, (tx) =>
    executeTransition(tx, tenantId, {
      instanceId,
      transitionId,
      actorId: ACTOR_ID,
      actorRoles: roles,
      triggeredBy: "system",
      ...(comment ? { comment } : {}),
    }),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = args.tenant;

  // Idempotent upsert — the API does this at boot, but the script may run first.
  await ModuleService.seedRegistry();
  await ModuleService.installModule(tenantId, MODULE_SLUG);
  const { entityTypeId, workflowId, transitionIds } =
    await loadConfig(tenantId);
  await wireNotifications(tenantId, args.notify);

  const fixturePath = join(
    getWorkspaceRoot(),
    "apps/api/src/scripts/fixtures/vendor-approval.json",
  );
  const fixtures = FixtureSchema.parse(
    JSON.parse(await readFile(fixturePath, "utf8")),
  );

  for (const { advanceTo, rejectAt, payload } of fixtures) {
    const fields = mapVendorPayload(payload);
    const instance = await findOrCreateVendor(
      tenantId,
      entityTypeId,
      workflowId,
      fields,
    );
    await advanceVendor(
      tenantId,
      instance,
      advanceTo,
      rejectAt ?? "it_security_review",
      transitionIds,
      fields.vendor_name,
    );
  }
}

type VendorRow = {
  id: string;
  currentState: string | null;
  fields: Record<string, unknown>;
};

// Keyed on external_ref so re-runs reuse the same record; together with
// advanceVendor resuming from currentState, a run that failed partway is
// completed by the next run rather than left stranded.
async function findOrCreateVendor(
  tenantId: string,
  entityTypeId: string,
  workflowId: string,
  fields: VendorFields,
): Promise<VendorRow> {
  return withTenantContext(tenantId, async (tx) => {
    const [existing] = await tx
      .select({
        id: entityInstances.id,
        currentState: entityInstances.currentState,
        fields: entityInstances.fields,
      })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.tenantId, tenantId),
          eq(entityInstances.entityTypeId, entityTypeId),
          sql`${entityInstances.fields}->>'external_ref' = ${fields.external_ref}`,
        ),
      );
    if (existing) {
      return {
        id: existing.id,
        currentState: existing.currentState,
        // jsonb column — entity fields are always an object map.
        fields: existing.fields as Record<string, unknown>,
      };
    }
    const created = await createEntity(tx, tenantId, {
      entityTypeId,
      workflowId,
      fields,
      createdBy: ACTOR_ID,
      actorId: ACTOR_ID,
      actorType: "system",
    });
    return {
      id: created.id,
      currentState: created.currentState,
      fields: created.fields,
    };
  });
}

async function advanceVendor(
  tenantId: string,
  vendor: VendorRow,
  advanceTo: (typeof STATES)[number],
  rejectAt: ReviewState,
  transitionIds: Map<string, string>,
  vendorName: string,
): Promise<void> {
  let state = vendor.currentState ?? "draft";
  let hasQuestionnaire = Boolean(vendor.fields["security_questionnaire"]);
  let hasContract = Boolean(vendor.fields["contract_draft"]);

  while (state !== advanceTo) {
    if (state === "approved" || state === "rejected") {
      logger.warn(
        { tenantId, instanceId: vendor.id, state, advanceTo },
        "Demo vendor already terminal in a different state — leaving as is",
      );
      return;
    }
    if (state === "draft" && !hasQuestionnaire) {
      await attachFile(
        tenantId,
        vendor.id,
        "security_questionnaire",
        vendorName,
      );
      hasQuestionnaire = true;
    }
    // Reject at rejectAt — or at the current review stage if a resumed vendor
    // is already past it, so a "rejected" fixture never walks on to approval.
    const rejectHere = rejectionStageFor(state, advanceTo, rejectAt);
    if (rejectHere) {
      const { role, comment } = REJECTORS[rejectHere];
      await step(
        tenantId,
        vendor.id,
        transitionIds.get(`${rejectHere}->rejected`),
        [role],
        comment,
      );
      state = "rejected";
      continue;
    }
    const hop = APPROVAL_PATH.find((h) => h.from === state);
    if (!hop) throw new Error(`no approval-path hop from state ${state}`);
    if (hop.from === "legal_review" && !hasContract) {
      await attachFile(tenantId, vendor.id, "contract_draft", vendorName);
      hasContract = true;
    }
    await step(
      tenantId,
      vendor.id,
      transitionIds.get(`${hop.from}->${hop.to}`),
      hop.roles,
    );
    state = hop.to;
  }
  logger.info(
    { tenantId, instanceId: vendor.id, state },
    "Demo vendor at target state",
  );
}

main()
  .then(async () => {
    await redis.quit();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    logger.error({ err }, "vendor-approval demo setup failed");
    await redis.quit();
    process.exit(1);
  });
