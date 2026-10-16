/**
 * Removing a file id from a comment's metadata.fileIds. Deleting the last attachment used to
 * fail: jsonb_agg over zero rows is NULL, so jsonb_set returned NULL and the NOT NULL column
 * (and, once migration 0148 lands, the metadata guard) refused the update.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  workflows,
  entityInstances,
  workflowEvents,
  withTenantContext,
} from "@platform/db";
import { removeFileIdFromMetadata } from "../../src/routes/entities/delete-comment-attachment.js";

const TENANT = "aaaaaaaa-0777-4000-a000-000000000964";

async function seedComment(metadata: Record<string, unknown>): Promise<string> {
  const [et] = await db
    .insert(entityTypes)
    .values({ tenantId: TENANT, name: `case-${Date.now()}`, plural: "cases" })
    .returning({ id: entityTypes.id });
  const [wf] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId: et!.id,
      name: "wf",
      initialState: "open",
    })
    .returning({ id: workflows.id });
  const [inst] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId: et!.id,
      workflowId: wf!.id,
      currentState: "open",
    })
    .returning({ id: entityInstances.id });
  const [ev] = await db
    .insert(workflowEvents)
    .values({
      tenantId: TENANT,
      instanceId: inst!.id,
      workflowId: wf!.id,
      fromState: null,
      toState: "open",
      triggeredBy: "user",
      actorId: "u-1",
      metadata,
    })
    .returning({ id: workflowEvents.id });
  return ev!.id;
}

async function removeFile(eventId: string, fileId: string): Promise<void> {
  await withTenantContext(TENANT, (tx) =>
    tx
      .update(workflowEvents)
      .set({ metadata: removeFileIdFromMetadata(fileId) })
      .where(eq(workflowEvents.id, eventId)),
  );
}

async function metadataOf(eventId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: workflowEvents.metadata })
    .from(workflowEvents)
    .where(eq(workflowEvents.id, eventId));
  // Cast: the column is jsonb; the tests only ever store objects in it.
  return row!.metadata as Record<string, unknown>;
}

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT,
      name: "att-delete",
      slug: `att-delete-${Date.now()}`,
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
  await db.delete(entityInstances).where(eq(entityInstances.tenantId, TENANT));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("removeFileIdFromMetadata", () => {
  it("leaves an empty fileIds array, and every other key, when the last file is removed", async () => {
    const id = await seedComment({
      type: "comment",
      text: "see attached",
      fileIds: ["f-1"],
    });
    await removeFile(id, "f-1");
    expect(await metadataOf(id)).toEqual({
      type: "comment",
      text: "see attached",
      fileIds: [],
    });
  });

  it("removes only the named file when there are several", async () => {
    const id = await seedComment({
      type: "comment",
      fileIds: ["f-1", "f-2", "f-3"],
    });
    await removeFile(id, "f-2");
    expect(await metadataOf(id)).toEqual({
      type: "comment",
      fileIds: ["f-1", "f-3"],
    });
  });

  it("is a no-op for the file list when the id is not present", async () => {
    const id = await seedComment({ type: "comment", fileIds: ["f-1"] });
    await removeFile(id, "f-9");
    expect(await metadataOf(id)).toEqual({
      type: "comment",
      fileIds: ["f-1"],
    });
  });

  it("gives a comment with no fileIds key an empty list", async () => {
    const id = await seedComment({ type: "comment", text: "no files" });
    await removeFile(id, "f-1");
    expect(await metadataOf(id)).toEqual({
      type: "comment",
      text: "no files",
      fileIds: [],
    });
  });
});
