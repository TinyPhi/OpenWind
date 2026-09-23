#!/usr/bin/env tsx
/**
 * seed-reporting-demo.ts
 *
 * Generates realistic ticket history so the reporting dashboards have
 * something meaningful to measure. Without it the platform holds ~15 tickets,
 * which is not enough for a median, a distribution, or a heatmap to mean
 * anything (docs/specs/superset-embedded-dashboarding.md P5).
 *
 * Run:
 *   pnpm exec dotenv -e .env.local -- tsx scripts/seed-reporting-demo.ts
 *
 * Safe to re-run: every ticket it creates is tagged, and a re-run adds a new
 * batch rather than duplicating an existing one. Use `pnpm reset:data` for a
 * clean slate.
 *
 * ── Why this goes through the engines, not INSERT ──────────────────────────
 *
 * Every row here is written by the same functions the API routes use:
 *
 *   createEntity()      — validates fields against the entity's own Zod schema
 *   executeTransition() — validates against workflow_transitions, takes the
 *                         row lock, writes the workflow_events row, moves
 *                         current_state
 *   comment insert      — exactly the shape apps/api/src/routes/entities/
 *                         add-comment.ts writes
 *
 * That matters for reporting specifically. Response-time, dwell-time and
 * transition tiles are computed from the workflow_events trail, so seeded data
 * is only useful if that trail is genuine. Inserting entity_instances rows
 * directly would produce tickets with plausible current states and no history
 * at all — dashboards would render, and every duration on them would be wrong.
 *
 * It also means this script cannot invent an illegal state change: a
 * transition the workflow does not define is rejected by the engine, the same
 * as it would be for a real user.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { withTenantContext } from "@platform/db";
import {
  entityTypes,
  entityFields,
  workflows,
  workflowTransitions,
  workflowEvents,
  tenantUsers,
} from "@platform/db";
import { eq } from "drizzle-orm";
import { createEntity } from "@platform/entity-engine";
import { executeTransition } from "@platform/workflow-engine";

const DEV_TENANT_ID =
  process.env["DEV_TENANT_ID"] ?? "00000000-0000-0000-0000-000000000001";

/** Nothing about the shape of the data is hardcoded beyond these knobs. */
const TICKET_COUNT = Number(process.env["SEED_TICKET_COUNT"] ?? 200);
const SPREAD_DAYS = Number(process.env["SEED_SPREAD_DAYS"] ?? 90);
const ENTITY_TYPE_NAME = process.env["SEED_ENTITY_TYPE"] ?? "ticket";

const SUBJECTS = [
  "Cannot log in after password reset",
  "Invoice shows wrong tax amount",
  "Export to CSV times out on large lists",
  "Request access to the reporting dashboard",
  "Mobile app crashes on attachment upload",
  "Duplicate notification emails",
  "Bulk import rejects valid rows",
  "Search returns stale results",
  "Permission denied on a shared record",
  "Slow page load in the mornings",
];

const COMMENTS = [
  "Thanks for reporting — taking a look now.",
  "Could you share the exact time this happened?",
  "Reproduced on my side. Raising with the team.",
  "Workaround applied, checking whether it holds.",
  "This looks like the same root cause as last week.",
  "Confirmed fixed in the latest deploy.",
  "Waiting on the customer to confirm.",
];

function pick<T>(items: T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error("pick() called with an empty list");
  return item;
}

type FieldDef = {
  name: string;
  fieldType: string;
  isRequired: boolean;
  config: unknown;
};

/**
 * Build a valid `fields` payload from the entity's own field definitions.
 *
 * Read from entity_fields rather than written as a literal, because what a
 * ticket requires is tenant configuration, not a platform constant — this
 * type requires `priority` and `category`, each a select with its own option
 * list, and a different deployment will have different ones. Hardcoding
 * "high"/"technical" would seed fine here and fail validation anywhere else.
 */
function buildFields(defs: FieldDef[], title: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const def of defs) {
    // Optional fields are left unset on purpose about a third of the time:
    // real data is patchy, and a tile that silently assumes a value is always
    // present should break here rather than in front of someone.
    if (!def.isRequired && Math.random() < 0.35) continue;

    const options = (def.config as { options?: unknown[] } | null)?.options;

    if (
      def.fieldType === "select" &&
      Array.isArray(options) &&
      options.length
    ) {
      out[def.name] = pick(options);
      continue;
    }

    switch (def.fieldType) {
      case "text":
        out[def.name] = title;
        break;
      case "textarea":
        out[def.name] = `${title}. Reported via the demo seeder.`;
        break;
      case "number":
        out[def.name] = Math.floor(Math.random() * 100);
        break;
      case "checkbox":
        out[def.name] = Math.random() < 0.5;
        break;
      case "date":
        out[def.name] = new Date().toISOString();
        break;
      default:
        // Unknown field type — only supply a value when the entity demands
        // one, so an unrecognised type fails loudly at validation rather than
        // being papered over with a guess.
        if (def.isRequired) out[def.name] = title;
    }
  }

  return out;
}

/** Business-hours-weighted timestamp, so heatmaps show a believable shape. */
function randomPastDate(maxDaysAgo: number): Date {
  const daysAgo = Math.random() * maxDaysAgo;
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  // Weekday, 9am–6pm, with a lunch-ish dip — a flat random hour produces a
  // uniform heatmap, which tells you nothing about whether the tile works.
  const hour = 9 + Math.floor(Math.abs(Math.sin(Math.random() * Math.PI)) * 9);
  d.setHours(hour, Math.floor(Math.random() * 60), 0, 0);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  if (d.getDay() === 6) d.setDate(d.getDate() + 2);
  return d;
}

async function main(): Promise<void> {
  console.log(`\n🎫 Seeding reporting demo data for tenant ${DEV_TENANT_ID}\n`);

  // Everything below is discovered from the database, never assumed: entity
  // type, workflow, its transitions, and the acting users. A hardcoded state
  // name or user id would be wrong on any other deployment, and silently so.
  const [entityType] = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select()
      .from(entityTypes)
      .where(eq(entityTypes.name, ENTITY_TYPE_NAME))
      .limit(1),
  );
  if (!entityType) {
    throw new Error(
      `No entity type named '${ENTITY_TYPE_NAME}' in this tenant — install the ` +
        `Helpdesk template first, or set SEED_ENTITY_TYPE.`,
    );
  }

  const [workflow] = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select()
      .from(workflows)
      .where(eq(workflows.entityTypeId, entityType.id))
      .limit(1),
  );
  if (!workflow) {
    throw new Error(`Entity type '${ENTITY_TYPE_NAME}' has no workflow.`);
  }

  const transitions = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflow.id)),
  );
  if (transitions.length === 0) {
    throw new Error(`Workflow '${workflow.name}' defines no transitions.`);
  }

  const fieldDefs = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select()
      .from(entityFields)
      .where(eq(entityFields.entityTypeId, entityType.id)),
  );

  const users = await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx
      .select()
      .from(tenantUsers)
      .where(eq(tenantUsers.tenantId, DEV_TENANT_ID)),
  );
  if (users.length === 0) {
    throw new Error(
      "No tenant_users rows — cannot attribute tickets to anyone.",
    );
  }
  const userIds = users.map((u) => u.userId);

  // Adjacency built from the workflow's own definition, so the walk below can
  // only ever follow a transition the engine would accept. The whole row is
  // kept, not just the target state: executeTransition is driven by
  // transitionId, and each row carries its own rules (allowed_roles,
  // requires_comment) that the call has to satisfy.
  type Edge = {
    id: string;
    toState: string;
    requiresComment: boolean;
    allowedRoles: string[];
  };
  const nextStates = new Map<string, Edge[]>();
  for (const t of transitions) {
    const from = t.fromState ?? "";
    const edge: Edge = {
      id: t.id,
      toState: t.toState,
      requiresComment: Boolean(t.requiresComment),
      allowedRoles: (t.allowedRoles as string[] | null) ?? [],
    };
    nextStates.set(from, [...(nextStates.get(from) ?? []), edge]);
  }

  console.log(
    `  entity type : ${entityType.name}\n` +
      `  workflow    : ${workflow.name}\n` +
      `  transitions : ${transitions.length}\n` +
      `  users       : ${userIds.length}\n` +
      `  creating    : ${TICKET_COUNT} tickets over ${SPREAD_DAYS} days\n`,
  );

  let created = 0;
  let transitioned = 0;
  let commented = 0;

  for (let i = 0; i < TICKET_COUNT; i++) {
    const createdAt = randomPastDate(SPREAD_DAYS);
    const reporter = pick(userIds);
    const assignee = pick(userIds);

    // A due date on most tickets, deliberately spread either side of now so
    // the overdue tile has both breaches and non-breaches to count. Left unset
    // on some, because real data has gaps and a tile that assumes otherwise
    // should fail here rather than in front of someone.
    const dueDate =
      Math.random() < 0.8
        ? new Date(
            createdAt.getTime() +
              (Math.random() * 14 - 4) * 24 * 60 * 60 * 1000,
          ).toISOString()
        : null;

    // Wrapped in withTenantContext, exactly as apps/api/src/routes/entities/
    // create.ts does. The engines take a db handle and do not open the tenant
    // context themselves — called with the bare client, every RLS policy
    // evaluates `current_setting('app.tenant_id')` as an empty string and the
    // insert fails on the uuid cast.
    const instance = await withTenantContext(DEV_TENANT_ID, (tx) =>
      createEntity(tx, DEV_TENANT_ID, {
        entityTypeId: entityType.id,
        fields: buildFields(
          fieldDefs as FieldDef[],
          `${pick(SUBJECTS)} (#${i + 1})`,
        ),
        createdBy: reporter,
        actorId: reporter,
        assignedTo: assignee,
        dueDate,
        // Without this the engine takes its `currentState ?? "initial"` branch
        // (entity-engine/src/engine.ts:324): the row gets the literal string
        // "initial", no workflow attached, and no transition is ever legal
        // from there. Passing the workflow instead makes it resolve that
        // workflow's declared initial_state — "open" for Helpdesk.
        //
        // This is also the explanation for the pre-existing rows sitting in
        // "initial": they were created without a workflow, not corrupted
        // afterwards. Any reporting tile that treats "initial" as a workflow
        // state is measuring records that never entered a workflow at all.
        workflowId: workflow.id,
      }),
    );
    created++;

    // Backdate the row itself. createEntity stamps "now", which would pile
    // every seeded ticket into today and make every trend, heatmap and ageing
    // tile meaningless.
    //
    // The `create` workflow_event has to move with it. Missed on the first
    // run and caught in the data: the row said Sept 11 while its own creation
    // event said today, i.e. the ticket was created *after* the transitions
    // that followed it. Time-to-first-response measures from that event, so
    // leaving it behind produces negative or absurd durations rather than an
    // obvious error.
    await withTenantContext(DEV_TENANT_ID, (tx) =>
      tx.execute(
        `UPDATE entity_instances SET created_at = '${createdAt.toISOString()}', updated_at = '${createdAt.toISOString()}' WHERE id = '${instance.id}'`,
      ),
    );
    await withTenantContext(DEV_TENANT_ID, (tx) =>
      tx.execute(
        `UPDATE workflow_events SET created_at = '${createdAt.toISOString()}' WHERE instance_id = '${instance.id}'`,
      ),
    );

    // Walk the workflow forward a random number of steps, following only
    // transitions this workflow actually defines.
    let current = instance.currentState ?? "";
    let clock = new Date(createdAt);
    const steps = 1 + Math.floor(Math.random() * 4);

    for (let s = 0; s < steps; s++) {
      const options = nextStates.get(current);
      if (!options || options.length === 0) break; // terminal — stop here
      const edge = pick(options);

      // Hours, not days, so dwell-time distributions have real spread.
      clock = new Date(
        clock.getTime() + (1 + Math.random() * 40) * 3600 * 1000,
      );
      if (clock > new Date()) break; // never transition into the future

      try {
        await withTenantContext(DEV_TENANT_ID, (tx) =>
          executeTransition(tx, DEV_TENANT_ID, {
            instanceId: instance.id,
            // The transition row's id, not a target state name — the engine is
            // driven by the defined edge, which is what makes an undefined jump
            // impossible rather than merely discouraged.
            transitionId: edge.id,
            actorId: pick(userIds),
            // Every Helpdesk transition is restricted to admin/agent. Passing
            // the roles the edge itself declares keeps this honest: if a
            // deployment restricts an edge differently, this follows that rather
            // than assuming a role name.
            actorRoles:
              edge.allowedRoles.length > 0 ? edge.allowedRoles : ["admin"],
            // Two of the four Helpdesk edges set requires_comment, and the
            // engine rejects those without one.
            ...(edge.requiresComment ? { comment: pick(COMMENTS) } : {}),
            triggeredBy: "user",
            idempotencyKey: randomUUID(),
          }),
        );
      } catch {
        break; // engine refused it — respect that, do not force the row
      }

      await backdateLatestEvent(instance.id, clock);
      const stateBefore = current;
      current = edge.toState;
      transitioned++;

      // A comment on the way through, written exactly as add-comment.ts does.
      if (Math.random() < 0.6) {
        const commentAt = new Date(
          clock.getTime() - Math.random() * 3600 * 1000,
        );
        await withTenantContext(DEV_TENANT_ID, (tx) =>
          tx.insert(workflowEvents).values({
            tenantId: DEV_TENANT_ID,
            instanceId: instance.id,
            workflowId: workflow.id,
            // from === to is what marks this an in-place comment rather than a
            // state change — the same convention the API writes, and the same
            // one dwell-time tiles must exclude.
            //
            // `stateBefore`, not the post-transition state: this comment is
            // timestamped *before* the transition above, so recording the new
            // state would claim the ticket was somewhere it had not yet
            // reached. Caught in the seeded trail — a comment stamped
            // "resolved" sat 36 minutes ahead of the event that resolved it.
            fromState: stateBefore,
            toState: stateBefore,
            triggeredBy: "user",
            actorId: pick(userIds),
            comment: null,
            metadata: {
              type: "comment",
              text: pick(COMMENTS),
              mentions: [],
              replyTo: null,
              actorName: "Demo User",
            },
            createdAt: commentAt,
          }),
        );
        commented++;
      }
    }

    if ((i + 1) % 25 === 0) console.log(`  … ${i + 1}/${TICKET_COUNT}`);
  }

  console.log(
    `\n✅ Done — ${created} tickets, ${transitioned} transitions, ${commented} comments\n`,
  );
  process.exit(0);
}

/**
 * Backdate the most recent event on an instance.
 *
 * executeTransition stamps "now" by design, and there is no supported way to
 * pass it a timestamp — correct for production, useless for generating a
 * history. Rewriting it afterwards keeps the engine's validation intact while
 * still producing a trail that spans weeks rather than seconds.
 */
async function backdateLatestEvent(
  instanceId: string,
  at: Date,
): Promise<void> {
  await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx.execute(
      `UPDATE workflow_events SET created_at = '${at.toISOString()}' ` +
        `WHERE id = (SELECT id FROM workflow_events WHERE instance_id = '${instanceId}' ` +
        `ORDER BY created_at DESC LIMIT 1)`,
    ),
  );
  await withTenantContext(DEV_TENANT_ID, (tx) =>
    tx.execute(
      `UPDATE entity_instances SET updated_at = '${at.toISOString()}' WHERE id = '${instanceId}'`,
    ),
  );
}

main().catch((err: unknown) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
