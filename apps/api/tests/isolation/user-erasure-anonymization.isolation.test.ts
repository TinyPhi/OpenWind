/**
 * #688 / docs/specs/user-erasure-anonymization.md: per-user erasure anonymizes
 * identity inside JSON payloads and comment text, and keeps business records
 * (API keys, resolved access requests, ended on-call shifts) with the identity
 * redacted instead of deleting them. Runs the real eraseUserFromTenant in the
 * route's exact context (withTenantContext, app.user_id unset).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  withTenantContext,
  entityTypes,
  entityFields,
  entityInstances,
  workflows,
  workflowEvents,
  tenantUsers,
  apiKeys,
  accessRequests,
  onCallSchedules,
  teams,
} from "@platform/db";
import {
  eraseUserFromTenant,
  API_KEY_ROTATION_GRACE_DAYS,
  type UserErasureResult,
} from "../../src/services/user-erasure.js";

const TENANT = "aaaaaaaa-0688-4000-a000-000000000001";
const BYSTANDER = "bbbbbbbb-0688-4000-b000-000000000002";
const TARGET = "u-anon-target";
const OTHER = "u-anon-other";
const TARGET_NAME = "Erin Target";
const REDACTED = "[REDACTED]";

const SEED = readFileSync(
  join(
    __dirname,
    "../../../worker/tests/isolation/fixtures/seed-every-tenant-table.sql",
  ),
  "utf8",
);

let typeId: string;
let workflowId: string;
let refInstanceId: string;
let otherRefInstanceId: string;
let mentioningCommentId: string;
let targetCommentId: string;
let unmentionedCommentId: string;
let targetKeyId: string;
let resolvedRequestId: string;
let endedShiftId: string;
let soonKeyId: string;
const soonExpiry = new Date(Date.now() + 2 * 86_400_000);
let erasureResult: UserErasureResult;
let boundaryCommentId: string;
let thirdPartyCommentId: string;
let changeEventId: string;
let bystanderCommentId: string;
let bystanderInstanceId: string;

type CommentMeta = {
  text?: string;
  mentions?: string[];
  actorName?: string;
};

async function comment(
  instanceId: string,
  actorId: string,
  metadata: Record<string, unknown>,
  tenantId = TENANT,
  wfId = workflowId,
): Promise<string> {
  const [row] = await db
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId,
      workflowId: wfId,
      fromState: "open",
      toState: "open",
      triggeredBy: "user",
      actorId,
      metadata: { type: "comment", ...metadata },
    })
    .returning();
  if (!row) throw new Error("seed: comment insert failed");
  return row.id;
}

async function eventMeta(id: string): Promise<CommentMeta> {
  const [row] = await db
    .select({ metadata: workflowEvents.metadata })
    .from(workflowEvents)
    .where(eq(workflowEvents.id, id));
  // jsonb payload — shapes seeded above
  return (row?.metadata ?? {}) as CommentMeta;
}

async function fieldsOf(id: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ fields: entityInstances.fields })
    .from(entityInstances)
    .where(eq(entityInstances.id, id));
  // jsonb payload
  return (row?.fields ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({ id: TENANT, name: "#688", slug: `anon-${TENANT}` })
    .onConflictDoNothing();
  await db.execute(
    sql.raw(
      SEED.replaceAll("__TENANT__", TENANT).replaceAll("__USER__", TARGET),
    ),
  );
  await db
    .update(tenantUsers)
    .set({ displayName: TARGET_NAME })
    .where(
      and(eq(tenantUsers.tenantId, TENANT), eq(tenantUsers.userId, TARGET)),
    );

  const [et] = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(eq(entityTypes.tenantId, TENANT));
  if (!et) throw new Error("seed: entity type missing");
  typeId = et.id;
  const [wf] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.tenantId, TENANT));
  if (!wf) throw new Error("seed: workflow missing");
  workflowId = wf.id;

  // user_ref fields: one required, one optional
  await db.insert(entityFields).values([
    {
      tenantId: TENANT,
      entityTypeId: typeId,
      name: "approver",
      label: "Approver",
      fieldType: "user_ref",
      isRequired: true,
    },
    {
      tenantId: TENANT,
      entityTypeId: typeId,
      name: "reviewer",
      label: "Reviewer",
      fieldType: "user_ref",
      isRequired: false,
    },
  ]);
  const [refInstance] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId: typeId,
      workflowId,
      currentState: "open",
      createdBy: OTHER,
      fields: { title: "refs", approver: TARGET, reviewer: TARGET },
    })
    .returning();
  const [otherRefInstance] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId: typeId,
      workflowId,
      currentState: "open",
      createdBy: OTHER,
      fields: { title: "other refs", approver: OTHER, reviewer: OTHER },
    })
    .returning();
  if (!refInstance || !otherRefInstance) throw new Error("seed: instances");
  refInstanceId = refInstance.id;
  otherRefInstanceId = otherRefInstance.id;

  mentioningCommentId = await comment(refInstanceId, OTHER, {
    text: `@${TARGET_NAME} can you sign off on the budget?`,
    mentions: [TARGET, "u-someone-else"],
    actorName: "Olly Other",
  });
  targetCommentId = await comment(refInstanceId, TARGET, {
    text: "Signed off — budget within limits.",
    mentions: [],
    actorName: TARGET_NAME,
  });
  // Same name in text, but no recorded mention of the target: a different
  // person who happens to share the name. Must stay untouched.
  unmentionedCommentId = await comment(refInstanceId, OTHER, {
    text: `@${TARGET_NAME} from the vendor side confirmed delivery.`,
    mentions: [],
    actorName: "Olly Other",
  });

  // "Erin Target" must not rewrite "@Erin Targetson" (a longer name)
  boundaryCommentId = await comment(refInstanceId, OTHER, {
    text: `@${TARGET_NAME} and @${TARGET_NAME}son please both review`,
    mentions: [TARGET, "u-targetson"],
    actorName: "Olly Other",
  });
  // Third-party write: the actor is the API key, the person is in metadata
  thirdPartyCommentId = await comment(refInstanceId, "api-key-actor", {
    text: "Posted via partner portal",
    mentions: [],
    actingPersonId: TARGET,
  });
  changeEventId = await comment(refInstanceId, OTHER, {
    type: "update",
    changed: {
      reviewer: { old: TARGET, new: OTHER },
      title: { old: "a", new: "refs" },
    },
  });

  // Bystander tenant: same user id and name in fields, comments and history
  await db
    .insert(tenants)
    .values({
      id: BYSTANDER,
      name: "#688 bystander",
      slug: `anon-${BYSTANDER}`,
    })
    .onConflictDoNothing();
  await db.execute(
    sql.raw(
      SEED.replaceAll("__TENANT__", BYSTANDER).replaceAll("__USER__", TARGET),
    ),
  );
  const [bet] = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(eq(entityTypes.tenantId, BYSTANDER));
  const [bwf] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.tenantId, BYSTANDER));
  if (!bet || !bwf) throw new Error("seed: bystander config");
  await db.insert(entityFields).values({
    tenantId: BYSTANDER,
    entityTypeId: bet.id,
    name: "reviewer",
    label: "Reviewer",
    fieldType: "user_ref",
    isRequired: false,
  });
  const [bInstance] = await db
    .insert(entityInstances)
    .values({
      tenantId: BYSTANDER,
      entityTypeId: bet.id,
      workflowId: bwf.id,
      currentState: "open",
      fields: { title: "b", reviewer: TARGET },
    })
    .returning();
  if (!bInstance) throw new Error("seed: bystander instance");
  bystanderInstanceId = bInstance.id;
  bystanderCommentId = await comment(
    bInstance.id,
    TARGET,
    {
      text: `@${TARGET_NAME} ping`,
      mentions: [TARGET],
      actorName: TARGET_NAME,
    },
    BYSTANDER,
    bwf.id,
  );

  const [key] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, TENANT), eq(apiKeys.createdBy, TARGET)));
  if (!key) throw new Error("seed: api key missing");
  targetKeyId = key.id;

  const [resolved] = await db
    .insert(accessRequests)
    .values({
      tenantId: TENANT,
      instanceId: refInstanceId,
      requesterId: TARGET,
      requestedLevel: "read_only",
      status: "approved",
      resolvedBy: OTHER,
    })
    .returning();
  if (!resolved) throw new Error("seed: access request");
  resolvedRequestId = resolved.id;

  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.tenantId, TENANT));
  if (!team) throw new Error("seed: team missing");
  const [ended] = await db
    .insert(onCallSchedules)
    .values({
      tenantId: TENANT,
      teamId: team.id,
      label: "last month",
      startsAt: new Date(Date.now() - 40 * 86_400_000),
      endsAt: new Date(Date.now() - 33 * 86_400_000),
      primaryUserId: TARGET,
      createdBy: OTHER,
    })
    .returning();
  if (!ended) throw new Error("seed: ended shift");
  endedShiftId = ended.id;

  const [soon] = await db
    .insert(apiKeys)
    .values({
      tenantId: TENANT,
      name: "expires soon",
      keyHash: `hash-soon-${TENANT}`,
      createdBy: TARGET,
      expiresAt: soonExpiry,
    })
    .returning();
  if (!soon) throw new Error("seed: soon key");
  soonKeyId = soon.id;

  erasureResult = await withTenantContext(TENANT, (tx) =>
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
  for (let pass = 0; pass < 6; pass++) {
    for (const { table_name } of tables) {
      await db
        .execute(
          sql`DELETE FROM ${sql.identifier(table_name)} WHERE tenant_id = ${TENANT}`,
        )
        .catch(() => undefined);
    }
  }
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

describe("per-user erasure anonymizes rather than deletes (#688)", () => {
  it("clears optional user_ref fields and redacts required ones", async () => {
    const fields = await fieldsOf(refInstanceId);
    expect(fields["approver"]).toBe(REDACTED);
    expect("reviewer" in fields).toBe(false);
    expect(fields["title"]).toBe("refs");
  });

  it("leaves other users' user_ref values alone", async () => {
    const fields = await fieldsOf(otherRefInstanceId);
    expect(fields).toMatchObject({ approver: OTHER, reviewer: OTHER });
  });

  it("scrubs the target from comment mentions and rewrites the @name in those comments", async () => {
    const meta = await eventMeta(mentioningCommentId);
    expect(meta.mentions).toEqual(["u-someone-else"]);
    expect(meta.text).toBe("@[REDACTED] can you sign off on the budget?");
    expect(meta.actorName).toBe("Olly Other");
  });

  it("keeps the target's own comment content, with the author anonymized", async () => {
    const meta = await eventMeta(targetCommentId);
    expect(meta.text).toBe("Signed off — budget within limits.");
    expect(meta.actorName).toBe(REDACTED);
  });

  it("does not touch a same-named @mention in a comment that never recorded the target", async () => {
    const meta = await eventMeta(unmentionedCommentId);
    expect(meta.text).toBe(
      `@${TARGET_NAME} from the vendor side confirmed delivery.`,
    );
  });

  it("keeps API keys the target created, active but on a forced rotation window", async () => {
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, targetKeyId));
    expect(key).toBeDefined();
    expect(key?.createdBy).toBe(REDACTED);
    expect(key?.revokedAt ?? null).toBeNull();
    const expiresAt = key?.expiresAt?.getTime() ?? 0;
    const graceMs = API_KEY_ROTATION_GRACE_DAYS * 86_400_000;
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + graceMs);
    expect(erasureResult.rotatedApiKeys.map((k) => k.id)).toContain(
      targetKeyId,
    );
  });

  it("never extends a key that already expires sooner than the rotation window", async () => {
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, soonKeyId));
    expect(key?.expiresAt?.getTime()).toBe(soonExpiry.getTime());
  });

  it("keeps resolved access requests with the requester redacted, and deletes pending ones", async () => {
    const [resolved] = await db
      .select()
      .from(accessRequests)
      .where(eq(accessRequests.id, resolvedRequestId));
    expect(resolved?.requesterId).toBe(REDACTED);
    expect(resolved?.status).toBe("approved");

    const pending = await db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.tenantId, TENANT),
          eq(accessRequests.status, "pending"),
        ),
      );
    expect(pending).toHaveLength(0);
  });

  it("keeps every on-call shift with the primary redacted, so backup cover stays", async () => {
    const shifts = await db
      .select()
      .from(onCallSchedules)
      .where(eq(onCallSchedules.tenantId, TENANT));
    const ended = shifts.find((s) => s.id === endedShiftId);
    expect(ended?.primaryUserId).toBe(REDACTED);
    // the fixture's current week-long shift survives too
    expect(
      shifts.some(
        (s) => s.primaryUserId === REDACTED && s.endsAt.getTime() > Date.now(),
      ),
    ).toBe(true);
    expect(shifts.map((s) => s.primaryUserId)).not.toContain(TARGET);
  });

  it("rewrites only the exact @name, not a longer name that starts with it", async () => {
    const meta = await eventMeta(boundaryCommentId);
    expect(meta.text).toBe(
      `@[REDACTED] and @${TARGET_NAME}son please both review`,
    );
  });

  it("redacts the acting person on third-party writes", async () => {
    const meta = (await eventMeta(thirdPartyCommentId)) as CommentMeta & {
      actingPersonId?: string;
    };
    expect(meta.actingPersonId).toBe(REDACTED);
  });

  it("redacts the user id in field-change history, keeping other changes", async () => {
    const meta = (await eventMeta(changeEventId)) as {
      changed?: Record<string, { old: unknown; new: unknown }>;
    };
    expect(meta.changed).toEqual({
      reviewer: { old: REDACTED, new: OTHER },
      title: { old: "a", new: "refs" },
    });
  });

  it("is idempotent: a second erasure of the same user succeeds and changes nothing", async () => {
    const snapshot = async (): Promise<unknown> => ({
      fields: await fieldsOf(refInstanceId),
      mentioning: await eventMeta(mentioningCommentId),
      authored: await eventMeta(targetCommentId),
      change: await eventMeta(changeEventId),
    });
    const before = await snapshot();
    const again = await withTenantContext(TENANT, (tx) =>
      eraseUserFromTenant(tx, TENANT, TARGET),
    );
    expect(again.rotatedApiKeys).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("leaves another tenant's fields, comments and names untouched", async () => {
    expect(await fieldsOf(bystanderInstanceId)).toMatchObject({
      reviewer: TARGET,
    });
    const meta = await eventMeta(bystanderCommentId);
    expect(meta).toMatchObject({
      text: `@${TARGET_NAME} ping`,
      mentions: [TARGET],
      actorName: TARGET_NAME,
    });
  });
});
