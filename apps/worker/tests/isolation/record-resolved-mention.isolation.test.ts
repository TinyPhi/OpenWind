/**
 * #689: recordResolvedMention appends a resolved user to a third-party
 * comment's metadata.mentions, so per-user erasure later finds the comment.
 * Real Postgres: checks the missing-key path (never NULLs metadata),
 * de-duplication, the tenant-member gate, concurrent jobs for one comment,
 * and that another tenant's comment can't be touched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  tenantUsers,
  workflows,
  entityInstances,
  workflowEvents,
} from "@platform/db";
import { recordResolvedMention } from "../../src/record-resolved-mention.js";

const TENANT = "aaaaaaaa-0689-4000-a000-000000000011";
const OTHER_TENANT = "bbbbbbbb-0689-4000-b000-000000000012";
const MEMBER = "u-689-member";
const SECOND_MEMBER = "u-689-second";
const NON_MEMBER = "u-689-outsider";

const SEED = readFileSync(
  join(__dirname, "fixtures/seed-every-tenant-table.sql"),
  "utf8",
);

async function thirdPartyComment(tenantId: string): Promise<string> {
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
      // The third-party route's shape: no mentions key at all.
      metadata: {
        type: "comment",
        text: "cc u-689-member@example.com",
        actorType: "api_key",
        actingPersonId: "u-689-author",
      },
    })
    .returning({ id: workflowEvents.id });
  if (!row) throw new Error("seed: comment insert failed");
  return row.id;
}

async function metadataOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: workflowEvents.metadata })
    .from(workflowEvents)
    .where(eq(workflowEvents.id, id));
  // jsonb payload — shape seeded above
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

let commentId: string;
let concurrentCommentId: string;
let otherTenantCommentId: string;

beforeAll(async () => {
  for (const [tenantId, user] of [
    [TENANT, MEMBER],
    [OTHER_TENANT, "u-689-other-tenant-user"],
  ] as const) {
    await db
      .insert(tenants)
      .values({
        id: tenantId,
        name: `#689 ${tenantId}`,
        slug: `mention-record-${tenantId}`,
      })
      .onConflictDoNothing();
    await db.execute(
      sql.raw(
        SEED.replaceAll("__TENANT__", tenantId).replaceAll("__USER__", user),
      ),
    );
  }
  await db
    .insert(tenantUsers)
    .values({ tenantId: TENANT, userId: SECOND_MEMBER });
  // MEMBER is also a member of the other tenant, so only the tenant filter
  // (not the member gate) can stop a cross-tenant write.
  await db
    .insert(tenantUsers)
    .values({ tenantId: OTHER_TENANT, userId: MEMBER });

  commentId = await thirdPartyComment(TENANT);
  concurrentCommentId = await thirdPartyComment(TENANT);
  otherTenantCommentId = await thirdPartyComment(OTHER_TENANT);
});

afterAll(async () => {
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'`);
  for (const tenantId of [TENANT, OTHER_TENANT]) {
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

describe("recordResolvedMention (#689)", () => {
  it("creates the mentions array on a comment that had none, keeping the rest of metadata", async () => {
    await recordResolvedMention(TENANT, commentId, MEMBER);

    const meta = await metadataOf(commentId);
    expect(meta["mentions"]).toEqual([MEMBER]);
    expect(meta["type"]).toBe("comment");
    expect(meta["text"]).toBe("cc u-689-member@example.com");
  });

  it("does not add the same user twice on a replay", async () => {
    await recordResolvedMention(TENANT, commentId, MEMBER);

    expect((await metadataOf(commentId))["mentions"]).toEqual([MEMBER]);
  });

  it("ignores a user who is not a member of the tenant", async () => {
    await recordResolvedMention(TENANT, commentId, NON_MEMBER);

    expect((await metadataOf(commentId))["mentions"]).toEqual([MEMBER]);
  });

  it("is a no-op for an unresolved mention's empty id", async () => {
    await recordResolvedMention(TENANT, commentId, "");

    expect((await metadataOf(commentId))["mentions"]).toEqual([MEMBER]);
  });

  it("keeps both ids when two jobs for the same comment run at once", async () => {
    await Promise.all([
      recordResolvedMention(TENANT, concurrentCommentId, MEMBER),
      recordResolvedMention(TENANT, concurrentCommentId, SECOND_MEMBER),
    ]);

    const mentions = (await metadataOf(concurrentCommentId))["mentions"];
    expect([...(mentions as string[])].sort()).toEqual(
      [MEMBER, SECOND_MEMBER].sort(),
    );
  });

  it("never writes to another tenant's comment, even for a user who belongs to both", async () => {
    await recordResolvedMention(TENANT, otherTenantCommentId, MEMBER);

    expect("mentions" in (await metadataOf(otherTenantCommentId))).toBe(false);
  });
});
