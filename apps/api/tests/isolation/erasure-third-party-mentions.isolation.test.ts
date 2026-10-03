/**
 * #689: third-party comments mention people by identifier (email, user id),
 * so per-user erasure used to leave those identifiers in the text.
 *  - Migration 0133 backfills metadata.mentions for existing third-party
 *    comments from the mention-resolution audit trail (members only).
 *  - eraseUserFromTenant then redacts the target's email and user id in the
 *    text of comments that mention them — and nowhere else (V2).
 * Real Postgres; runs the migration SQL and the real erasure service.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  tenantUsers,
  workflows,
  entityInstances,
  workflowEvents,
  adminAuditLog,
  withTenantContext,
} from "@platform/db";
import { eraseUserFromTenant } from "../../src/services/user-erasure.js";

const TENANT = "aaaaaaaa-0689-4000-a000-000000000001";
const BYSTANDER = "bbbbbbbb-0689-4000-b000-000000000002";
const TARGET = "u-689-target";
const TARGET_EMAIL = "alice.target@example.com";
const OTHER = "u-689-other";
const OTHER_EMAIL = "bob.other@example.com";

const SEED = readFileSync(
  join(
    __dirname,
    "../../../worker/tests/isolation/fixtures/seed-every-tenant-table.sql",
  ),
  "utf8",
);
const BACKFILL = readFileSync(
  join(
    __dirname,
    "../../../../packages/db/migrations/0133_workflow_events_backfill_third_party_mentions.sql",
  ),
  "utf8",
);

type Meta = { text?: string; mentions?: string[]; type?: string };

async function thirdPartyComment(
  tenantId: string,
  text: string,
): Promise<string> {
  const [wf] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.tenantId, tenantId));
  const [instance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(eq(entityInstances.tenantId, tenantId));
  if (!wf || !instance) throw new Error("seed: workflow/instance missing");
  const [row] = await db
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId: instance.id,
      workflowId: wf.id,
      fromState: "open",
      toState: "open",
      triggeredBy: "api_key",
      actorId: "u-689-author",
      metadata: {
        type: "comment",
        text,
        actorType: "api_key",
        actingPersonId: "u-689-author",
      },
    })
    .returning({ id: workflowEvents.id });
  if (!row) throw new Error("seed: comment insert failed");
  return row.id;
}

async function tagAudit(
  tenantId: string,
  action: "tag.resolved_existing_access" | "tag.fallback" | "tag.auto_granted",
  metadata: Record<string, unknown>,
): Promise<void> {
  const [instance] = await db
    .select({ id: entityInstances.id })
    .from(entityInstances)
    .where(eq(entityInstances.tenantId, tenantId));
  if (!instance) throw new Error("seed: instance missing");
  await db.insert(adminAuditLog).values({
    tenantId,
    actorId: "u-689-author",
    actorType: "user",
    resourceType: "entity_instance",
    resourceId: instance.id,
    action,
    metadata,
  });
}

async function meta(id: string): Promise<Meta> {
  const [row] = await db
    .select({ metadata: workflowEvents.metadata })
    .from(workflowEvents)
    .where(eq(workflowEvents.id, id));
  // jsonb payload — shapes seeded above
  return (row?.metadata ?? {}) as Meta;
}

const ids: Record<string, string> = {};
const afterBackfill: Record<string, Meta> = {};
const afterSecondBackfill: Record<string, Meta> = {};

beforeAll(async () => {
  for (const tenantId of [TENANT, BYSTANDER]) {
    await db
      .insert(tenants)
      .values({
        id: tenantId,
        name: `#689 ${tenantId}`,
        slug: `erasure-tp-${tenantId}`,
      })
      .onConflictDoNothing();
    await db.execute(
      sql.raw(
        SEED.replaceAll("__TENANT__", tenantId).replaceAll("__USER__", TARGET),
      ),
    );
    await db
      .update(tenantUsers)
      .set({ email: TARGET_EMAIL, displayName: "Alice Target" })
      .where(
        and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, TARGET)),
      );
  }
  await db
    .insert(tenantUsers)
    .values({ tenantId: TENANT, userId: OTHER, email: OTHER_EMAIL });

  // Mentioned by email, resolved to "already had access" (identifier only).
  ids["byEmail"] = await thirdPartyComment(
    TENANT,
    "Please review, @Alice.Target@Example.com — not malice.target@example.com",
  );
  await tagAudit(TENANT, "tag.resolved_existing_access", {
    commentId: ids["byEmail"],
    mentionIdentifier: "Alice.Target@Example.com",
  });
  // Mentioned by user id, auto-granted (grantedUserId recorded).
  ids["byId"] = await thirdPartyComment(TENANT, `cc ${TARGET} on this`);
  await tagAudit(TENANT, "tag.auto_granted", {
    commentId: ids["byId"],
    mentionIdentifier: TARGET,
    grantedUserId: TARGET,
  });
  // Two people mentioned; only the target is erased.
  ids["both"] = await thirdPartyComment(
    TENANT,
    `@${TARGET_EMAIL} and @${OTHER_EMAIL}`,
  );
  await tagAudit(TENANT, "tag.resolved_existing_access", {
    commentId: ids["both"],
    mentionIdentifier: TARGET_EMAIL,
  });
  await tagAudit(TENANT, "tag.resolved_existing_access", {
    commentId: ids["both"],
    mentionIdentifier: OTHER_EMAIL,
  });
  // The email in free text, with no recorded mention: V2 says leave it.
  ids["unmentioned"] = await thirdPartyComment(
    TENANT,
    `${TARGET_EMAIL} said hi`,
  );
  // An identifier that never matched a member: nothing to record.
  ids["ghost"] = await thirdPartyComment(TENANT, "ping ghost@example.com");
  await tagAudit(TENANT, "tag.fallback", {
    commentId: ids["ghost"],
    mentionIdentifier: "ghost@example.com",
  });
  // Same target, same text, other tenant: erasure in TENANT must not reach it.
  ids["bystander"] = await thirdPartyComment(BYSTANDER, `@${TARGET_EMAIL} hi`);
  await tagAudit(BYSTANDER, "tag.resolved_existing_access", {
    commentId: ids["bystander"],
    mentionIdentifier: TARGET_EMAIL,
  });
  // An email ending a sentence or inside brackets is still the address; a
  // longer domain is a different address.
  ids["punctuated"] = await thirdPartyComment(
    TENANT,
    `Loop in ${TARGET_EMAIL}. Also (${TARGET_EMAIL}), ${TARGET_EMAIL}, not ${TARGET_EMAIL}.au`,
  );
  await tagAudit(TENANT, "tag.resolved_existing_access", {
    commentId: ids["punctuated"],
    mentionIdentifier: TARGET_EMAIL,
  });
  // Cross-tenant guards in the backfill. A TENANT audit row naming a
  // BYSTANDER comment must not write to it, and a BYSTANDER audit row naming
  // OTHER (a TENANT-only member) must not record OTHER there.
  ids["crossTarget"] = await thirdPartyComment(BYSTANDER, "unrelated");
  await tagAudit(TENANT, "tag.auto_granted", {
    commentId: ids["crossTarget"],
    mentionIdentifier: TARGET,
    grantedUserId: TARGET,
  });
  ids["otherInBystander"] = await thirdPartyComment(
    BYSTANDER,
    `@${OTHER_EMAIL} hello`,
  );
  await tagAudit(BYSTANDER, "tag.resolved_existing_access", {
    commentId: ids["otherInBystander"],
    mentionIdentifier: OTHER_EMAIL,
  });

  await db.execute(sql.raw(BACKFILL));
  for (const [key, id] of Object.entries(ids))
    afterBackfill[key] = await meta(id);
  await db.execute(sql.raw(BACKFILL));
  for (const [key, id] of Object.entries(ids)) {
    afterSecondBackfill[key] = await meta(id);
  }

  await withTenantContext(TENANT, (tx) =>
    eraseUserFromTenant(tx, TENANT, TARGET),
  );
});

afterAll(async () => {
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'`);
  for (const tenantId of [TENANT, BYSTANDER]) {
    for (let pass = 0; pass < 6; pass++) {
      for (const { table_name } of tables) {
        await db
          .execute(
            sql`DELETE FROM ${sql.identifier(table_name)} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => undefined);
      }
    }
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});

describe("backfill migration 0133 (#689)", () => {
  it("records a member mentioned by email, matching case-insensitively", () => {
    expect(afterBackfill["byEmail"]?.mentions).toEqual([TARGET]);
    expect(afterBackfill["byEmail"]?.type).toBe("comment");
  });

  it("records a member from an auto-grant's grantedUserId", () => {
    expect(afterBackfill["byId"]?.mentions).toEqual([TARGET]);
  });

  it("records every member a comment mentions", () => {
    expect([...(afterBackfill["both"]?.mentions ?? [])].sort()).toEqual(
      [OTHER, TARGET].sort(),
    );
  });

  it("leaves comments with no member resolution untouched", () => {
    expect("mentions" in (afterBackfill["ghost"] ?? {})).toBe(false);
    expect("mentions" in (afterBackfill["unmentioned"] ?? {})).toBe(false);
  });

  it("never writes to a comment in another tenant than the audit row's", () => {
    expect("mentions" in (afterBackfill["crossTarget"] ?? {})).toBe(false);
  });

  it("only records members of the comment's own tenant", () => {
    expect("mentions" in (afterBackfill["otherInBystander"] ?? {})).toBe(false);
  });

  it("is a no-op on a second run", () => {
    expect(afterSecondBackfill).toEqual(afterBackfill);
  });
});

describe("erasure redacts third-party mentions (#689)", () => {
  it("redacts the target's email, whatever its case, and not a longer address", async () => {
    const m = await meta(ids["byEmail"] ?? "");
    expect(m.text).toBe(
      "Please review, @[REDACTED] — not malice.target@example.com",
    );
    expect(m.mentions).toEqual([]);
  });

  it("redacts an email followed by punctuation, but not a longer domain", async () => {
    expect((await meta(ids["punctuated"] ?? "")).text).toBe(
      `Loop in [REDACTED]. Also ([REDACTED]), [REDACTED], not ${TARGET_EMAIL}.au`,
    );
  });

  it("redacts the target's user id", async () => {
    expect((await meta(ids["byId"] ?? "")).text).toBe("cc [REDACTED] on this");
  });

  it("keeps another mentioned person's email and mention", async () => {
    const m = await meta(ids["both"] ?? "");
    expect(m.text).toBe(`@[REDACTED] and @${OTHER_EMAIL}`);
    expect(m.mentions).toEqual([OTHER]);
  });

  it("does not rewrite a comment that never recorded the target (V2)", async () => {
    expect((await meta(ids["unmentioned"] ?? "")).text).toBe(
      `${TARGET_EMAIL} said hi`,
    );
  });

  it("does not touch another tenant's comment", async () => {
    const m = await meta(ids["bystander"] ?? "");
    expect(m.text).toBe(`@${TARGET_EMAIL} hi`);
    expect(m.mentions).toEqual([TARGET]);
  });
});
