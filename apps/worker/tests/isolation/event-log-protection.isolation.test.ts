/**
 * docs/specs/event-log-protection.md (migration 0147) -- as app_user, a workflow_events row's
 * metadata can still be edited (comment attachments, mentions, erasure), but its state,
 * timestamps and actor cannot, and it cannot be deleted. Deletes go through
 * event_log_maintenance_role, which RLS still confines to one tenant and which cannot UPDATE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  workflows,
  entityInstances,
  workflowEvents,
  withTenantContext,
  withEventLogMaintenanceContext,
} from "@platform/db";

const TENANT = "aaaaaaaa-0777-4000-a000-000000000001";
const OTHER = "bbbbbbbb-0777-4000-b000-000000000002";
const ids: Record<string, { event: string; rich: string }> = {};

async function seed(tenantId: string, name: string): Promise<void> {
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
  const [inst] = await db
    .insert(entityInstances)
    .values({
      tenantId,
      entityTypeId: et!.id,
      workflowId: wf!.id,
      currentState: "open",
    })
    .returning({ id: entityInstances.id });
  const [ev] = await db
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId: inst!.id,
      workflowId: wf!.id,
      fromState: null,
      toState: "open",
      triggeredBy: "user",
      actorId: "u-1",
      originMechanism: "api",
      originOidcClientId: "client-1",
      originPerformerUserId: "person-1",
    })
    .returning({ id: workflowEvents.id });
  const [rich] = await db
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId: inst!.id,
      workflowId: wf!.id,
      fromState: "open",
      toState: "open",
      triggeredBy: "user",
      actorId: "u-1",
      metadata: {
        type: "update",
        actingPersonId: "p-1",
        actorName: "Ada",
        changed: {
          assignee: { old: "u-9", new: "u-2" },
          note: { old: "a", new: "b" },
        },
        fileIds: [],
      },
    })
    .returning({ id: workflowEvents.id });
  ids[tenantId] = { event: ev!.id, rich: rich!.id };
}

beforeAll(async () => {
  await seed(TENANT, "evlog-a");
  await seed(OTHER, "evlog-b");
});

afterAll(async () => {
  for (const t of [TENANT, OTHER]) {
    await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, t));
    await db.delete(entityInstances).where(eq(entityInstances.tenantId, t));
    await db.delete(workflows).where(eq(workflows.tenantId, t));
    await db.delete(entityTypes).where(eq(entityTypes.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
});

describe("workflow_events as app_user", () => {
  it("can still edit metadata", async () => {
    await withTenantContext(TENANT, (tx) =>
      tx
        .update(workflowEvents)
        .set({
          metadata: sql`jsonb_build_object('fileIds', jsonb_build_array('f-1'))`,
        })
        .where(eq(workflowEvents.id, ids[TENANT]!.event)),
    );
    const [row] = await db
      .select({ metadata: workflowEvents.metadata })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, ids[TENANT]!.event));
    expect(row?.metadata).toEqual({ fileIds: ["f-1"] });
  });

  it("can redact the actor and origin performer, as per-user erasure does", async () => {
    await withTenantContext(TENANT, (tx) =>
      tx
        .update(workflowEvents)
        .set({ actorId: "[REDACTED]", originPerformerUserId: "[REDACTED]" })
        .where(eq(workflowEvents.id, ids[TENANT]!.event)),
    );
    const [row] = await db
      .select({
        actorId: workflowEvents.actorId,
        origin: workflowEvents.originPerformerUserId,
      })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, ids[TENANT]!.event));
    expect(row).toEqual({ actorId: "[REDACTED]", origin: "[REDACTED]" });
  });

  it.each([
    ["to_state", { toState: "closed" }],
    ["from_state", { fromState: "open" }],
    ["created_at", { createdAt: new Date(0) }],
    ["actor_id (re-attribution)", { actorId: "someone-else" }],
    [
      "origin_performer_user_id (re-attribution)",
      { originPerformerUserId: "someone-else" },
    ],
    ["triggered_by", { triggeredBy: "system" as const }],
  ])("cannot rewrite %s", async (_col, set) => {
    await expect(
      withTenantContext(TENANT, (tx) =>
        tx
          .update(workflowEvents)
          .set(set)
          .where(eq(workflowEvents.id, ids[TENANT]!.event)),
      ),
    ).rejects.toThrow();
  });

  it("cannot delete an event", async () => {
    await expect(
      withTenantContext(TENANT, (tx) =>
        tx
          .delete(workflowEvents)
          .where(eq(workflowEvents.id, ids[TENANT]!.event)),
      ),
    ).rejects.toThrow();
    const rows = await db
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, ids[TENANT]!.event));
    expect(rows).toHaveLength(1);
  });
});

describe("workflow_events.metadata guard (migration 0148), as app_user", () => {
  async function setMetadata(metadata: Record<string, unknown>): Promise<void> {
    await withTenantContext(TENANT, (tx) =>
      tx
        .update(workflowEvents)
        .set({ metadata })
        .where(eq(workflowEvents.id, ids[TENANT]!.rich)),
    );
  }
  async function current(): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ metadata: workflowEvents.metadata })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, ids[TENANT]!.rich));
    return row!.metadata as Record<string, unknown>;
  }
  const base = (): Promise<Record<string, unknown>> => current();

  // Drizzle wraps the driver error; the trigger's SQLSTATE and message sit on its cause.
  async function expectRefused(
    attempt: Promise<void>,
    message: RegExp,
  ): Promise<void> {
    const err: unknown = await attempt.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    // Cast: the error's shape is only known from the driver, not the type system.
    const cause = (err as { cause?: { code?: string; message?: string } })
      .cause;
    expect(cause?.code).toBe("42501");
    expect(cause?.message).toMatch(message);
  }
  const ONLY_LISTED = /only fileIds, mentions, mentionIdentifiers/;
  const CHANGED_ONLY_REDACTED =
    /changed may only have its old\/new values redacted/;

  it("lets the editable keys change", async () => {
    await setMetadata({
      ...(await base()),
      fileIds: ["f-1"],
      mentions: ["u-2"],
      mentionIdentifiers: { "u-2": ["ada"] },
      text: "hello",
    });
    expect((await current())["fileIds"]).toEqual(["f-1"]);
  });

  it("refuses to change or clear type, or to add another key", async () => {
    await expectRefused(
      setMetadata({ ...(await base()), type: "comment" }),
      ONLY_LISTED,
    );
    const { type: _type, ...withoutType } = await base();
    await expectRefused(setMetadata(withoutType), ONLY_LISTED);
    await expectRefused(
      setMetadata({ ...(await base()), extra: 1 }),
      ONLY_LISTED,
    );
    expect((await current())["type"]).toBe("update");
  });

  it("allows actingPersonId and actorName to be redacted but not rewritten", async () => {
    await expectRefused(
      setMetadata({ ...(await base()), actingPersonId: "p-2" }),
      /actingPersonId may only be redacted/,
    );
    await expectRefused(
      setMetadata({ ...(await base()), actorName: "Grace" }),
      /actorName may only be redacted/,
    );
    await setMetadata({
      ...(await base()),
      actingPersonId: "[REDACTED]",
      actorName: "[REDACTED]",
    });
    expect((await current())["actorName"]).toBe("[REDACTED]");
  });

  it("allows changed.<field>.old/new to be redacted but nothing else about it", async () => {
    const m = await base();
    const changed = m["changed"] as Record<string, Record<string, unknown>>;
    await expectRefused(
      setMetadata({
        ...m,
        changed: { ...changed, assignee: { old: "u-1", new: "u-2" } },
      }),
      CHANGED_ONLY_REDACTED,
    );
    await expectRefused(
      setMetadata({ ...m, changed: { assignee: changed["assignee"] } }),
      CHANGED_ONLY_REDACTED,
    );
    await expectRefused(
      setMetadata({
        ...m,
        changed: { ...changed, extra: { old: "x", new: "y" } },
      }),
      CHANGED_ONLY_REDACTED,
    );
    const { changed: _changed, ...withoutChanged } = m;
    await expectRefused(setMetadata(withoutChanged), CHANGED_ONLY_REDACTED);
    await expectRefused(
      setMetadata({ ...m, changed: "[REDACTED]" }),
      CHANGED_ONLY_REDACTED,
    );
    await setMetadata({
      ...m,
      changed: {
        ...changed,
        assignee: { old: "[REDACTED]", new: "u-2" },
      },
    });
    const after = (await current())["changed"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(after["assignee"]).toEqual({ old: "[REDACTED]", new: "u-2" });
  });
});

describe("event_log_maintenance_role", () => {
  it("cannot UPDATE an event", async () => {
    await expect(
      withEventLogMaintenanceContext(TENANT, (tx) =>
        tx
          .update(workflowEvents)
          .set({ toState: "closed" })
          .where(eq(workflowEvents.id, ids[TENANT]!.event)),
      ),
    ).rejects.toThrow();
  });

  it("deletes only the tenant in context, even without a tenant filter", async () => {
    await withEventLogMaintenanceContext(TENANT, (tx) =>
      tx.execute(sql`DELETE FROM workflow_events`),
    );
    const mine = await db
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, ids[TENANT]!.event));
    const theirs = await db
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.id, ids[OTHER]!.event));
    expect(mine).toHaveLength(0);
    expect(theirs).toHaveLength(1);
  });
});
