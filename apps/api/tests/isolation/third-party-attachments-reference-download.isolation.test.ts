/**
 * Isolation tests for attachment reference-binding on ticket-create /
 * comment-post, and GET /api/v1/attachments/:id/download (ADR-012 Phase D,
 * Stage 2, spec R3/R4/R6/R7).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  entityInstances,
  attachments,
  files,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { presignAttachmentHandler } from "../../src/routes/third-party/attachments-presign.js";
import { uploadAttachmentHandler } from "../../src/routes/third-party/attachments-upload.js";
import { downloadAttachmentHandler } from "../../src/routes/third-party/attachments-download.js";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";
import { createThirdPartyTicketHandler } from "../../src/routes/third-party/tickets.js";

const TENANT = "aabbccdd-0000-4000-a000-000000000801";
const OTHER_TENANT = "aabbccdd-0000-4000-a000-000000000802";

let entityTypeId: string;
let workflowId: string;
let ticketA: string;
let ticketB: string;
let noAccessTicketId: string;
let otherTenantAttachmentId: string;

const CREATOR = "third-party-attachment-ref-creator";
const NO_ACCESS_PERSON = "third-party-attachment-ref-no-access";
const READ_COMMENT_PERSON = "third-party-attachment-ref-read-comment";

async function grantAccess(
  ticketId: string,
  userId: string,
  level: "read_only" | "read_comment" | "read_write",
) {
  await db
    .update(entityInstances)
    .set({
      fields: sql`jsonb_set(
        jsonb_set(
          fields,
          '{__accessUsers}',
          CASE
            WHEN jsonb_typeof(COALESCE(fields->'__accessUsers', 'null'::jsonb)) = 'object'
            THEN fields->'__accessUsers'
            ELSE '{}'::jsonb
          END
        ),
        ARRAY['__accessUsers', ${userId}::text],
        jsonb_build_object('level', to_jsonb(${level}::text), 'tag', 'mention')
      )`,
    })
    .where(eq(entityInstances.id, ticketId));
}

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT,
      name: "3P Attachment Ref Tenant",
      slug: `3p-attach-ref-${TENANT}`,
    },
    {
      id: OTHER_TENANT,
      name: "3P Attachment Ref Other Tenant",
      slug: `3p-attach-ref-other-${OTHER_TENANT}`,
    },
  ]);

  const entityType = await createEntityType(db, null, {
    name: `third_party_attachment_ref_test_${Date.now()}`,
    plural: "third_party_attachment_ref_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Attachment Ref Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });
  workflowId = workflow!.id;

  await db.insert(workflowStates).values({
    tenantId: TENANT,
    workflowId,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });

  const a = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  ticketA = a.id;
  await grantAccess(ticketA, READ_COMMENT_PERSON, "read_comment");

  const b = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  ticketB = b.id;

  const noAccess = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  noAccessTicketId = noAccess.id;

  // A completed-upload attachment belonging to OTHER_TENANT, to prove
  // cross-tenant references are rejected as 404.
  const [otherAttachment] = await db
    .insert(attachments)
    .values({
      tenantId: OTHER_TENANT,
      uploadedBy: "api_key",
      actingPersonId: CREATOR,
      declaredFilename: "x.txt",
      declaredSizeBytes: 1,
      declaredMimeType: "text/plain",
      uploadTokenHash: "unused",
      uploadExpiresAt: new Date(Date.now() + 60_000),
      status: "uploaded",
    })
    .returning({ id: attachments.id });
  otherTenantAttachmentId = otherAttachment!.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp() {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    const actingPersonId = c.req.header("x-test-acting-person") ?? CREATOR;
    c.set("auth", {
      userId: "apikey:55555555-5555-5555-5555-555555555555",
      tenantId: TENANT,
      roles: [
        "entity:ticket:attach",
        "entity:ticket:comment",
        "entity:ticket:create",
        "entity:ticket:read",
      ],
      email: "",
      displayName: "API Key 55555555",
      orgId: "org-ggg",
    });
    c.set("actingPerson", {
      userId: actingPersonId,
      email: `${actingPersonId}@example.com`,
      displayName: actingPersonId,
      orgId: "org-ggg",
    });
    await next();
  });
  app.post("/attachments/presign", ...presignAttachmentHandler);
  app.put("/attachments/:id/upload", ...uploadAttachmentHandler);
  app.get("/attachments/:id/download", ...downloadAttachmentHandler);
  app.post("/tickets", ...createThirdPartyTicketHandler);
  app.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
  return app;
}

async function createUploadedAttachment(
  app: Hono<Vars>,
  actingPerson = CREATOR,
): Promise<string> {
  const presignRes = await app.request("/attachments/presign", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-acting-person": actingPerson,
    },
    body: JSON.stringify({
      filename: "f.txt",
      sizeBytes: 5,
      mimeType: "text/plain",
    }),
  });
  const { data } = (await presignRes.json()) as {
    data: { attachmentId: string; uploadUrl: string };
  };
  const token = new URL(data.uploadUrl, "http://x").searchParams.get("token")!;
  const uploadRes = await app.request(
    `/attachments/${data.attachmentId}/upload?token=${token}`,
    {
      method: "PUT",
      headers: { "x-test-acting-person": actingPerson },
      body: new TextEncoder().encode("hello"),
    },
  );
  expect(uploadRes.status).toBe(201);

  // Force the underlying file straight to 'clean' -- same pattern as
  // files.isolation.test.ts. Without SKIP_AV_SCAN (unset in CI, unlike some
  // local .env.local setups), the real AV-scan job is enqueued async and
  // won't have completed by the time a download test runs immediately
  // after upload; this helper isn't exercising the scan pipeline itself,
  // only download access-gating, so it doesn't need to wait for a real scan.
  const [row] = await db
    .select({ filesId: attachments.filesId })
    .from(attachments)
    .where(eq(attachments.id, data.attachmentId));
  if (row?.filesId) {
    await db
      .update(files)
      .set({ scanStatus: "clean" })
      .where(eq(files.id, row.filesId));
  }

  return data.attachmentId;
}

describe("attachment references on comment-post", () => {
  it("binds an unbound completed attachment to the commented ticket", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);

    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "see attached",
        attachmentIds: [attachmentId],
      }),
    });
    expect(res.status).toBe(201);

    const [row] = await db
      .select({ ticketId: attachments.ticketId, boundAt: attachments.boundAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(row?.ticketId).toBe(ticketA);
    expect(row?.boundAt).not.toBeNull();
  });

  it("rejects referencing an already-bound attachment from a different ticket", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);

    const first = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "first", attachmentIds: [attachmentId] }),
    });
    expect(first.status).toBe(201);

    const second = await app.request(`/tickets/${ticketB}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "second", attachmentIds: [attachmentId] }),
    });
    expect(second.status).toBe(422);
  });

  it("allows idempotent re-reference of an attachment already bound to the same ticket", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);

    const first = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "first", attachmentIds: [attachmentId] }),
    });
    expect(first.status).toBe(201);

    const again = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "again", attachmentIds: [attachmentId] }),
    });
    expect(again.status).toBe(201);
  });

  it("rejects a reference to an attachment whose upload never completed", async () => {
    const app = makeApp();
    const presignRes = await app.request("/attachments/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "f.txt",
        sizeBytes: 5,
        mimeType: "text/plain",
      }),
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string };
    };

    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "no upload yet",
        attachmentIds: [data.attachmentId],
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects a reference to a nonexistent attachment id as not found", async () => {
    const app = makeApp();
    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "bad ref",
        attachmentIds: ["00000000-0000-4000-8000-000000000000"],
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a reference to a different tenant's attachment as not found", async () => {
    const app = makeApp();
    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "cross tenant",
        attachmentIds: [otherTenantAttachmentId],
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects more than 10 attachment ids at the schema layer", async () => {
    const app = makeApp();
    const ids = Array.from(
      { length: 11 },
      () => "00000000-0000-4000-8000-000000000000",
    );
    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "too many", attachmentIds: ids }),
    });
    // Caught by CreateThirdPartyCommentSchema's own .max(10) before
    // referenceAttachments's identical runtime check ever runs.
    expect(res.status).toBe(400);
  });

  it("rejects a reference from a different ticket than the one it was presigned for", async () => {
    const app = makeApp();
    const presignRes = await app.request("/attachments/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "f.txt",
        sizeBytes: 5,
        mimeType: "text/plain",
        ticketId: ticketA,
      }),
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string; uploadUrl: string };
    };
    const token = new URL(data.uploadUrl, "http://x").searchParams.get(
      "token",
    )!;
    const uploadRes = await app.request(
      `/attachments/${data.attachmentId}/upload?token=${token}`,
      { method: "PUT", body: new TextEncoder().encode("hello") },
    );
    expect(uploadRes.status).toBe(201);

    const res = await app.request(`/tickets/${ticketB}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "wrong ticket",
        attachmentIds: [data.attachmentId],
      }),
    });
    expect(res.status).toBe(422);

    const [row] = await db
      .select({ boundAt: attachments.boundAt })
      .from(attachments)
      .where(eq(attachments.id, data.attachmentId));
    expect(row?.boundAt).toBeNull();
  });

  it("rejects binding an attachment uploaded by a different acting person, even with ticket access — PR #472 review finding 2", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app, CREATOR);

    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-acting-person": NO_ACCESS_PERSON,
      },
      body: JSON.stringify({
        text: "stolen attachment",
        attachmentIds: [attachmentId],
      }),
    });
    expect(res.status).toBe(404);

    const [row] = await db
      .select({ boundAt: attachments.boundAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(row?.boundAt).toBeNull();
  });

  it("deduplicates a repeated attachment id instead of rolling back on ATTACHMENT_ALREADY_BOUND — PR #472 review finding 4", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);

    const res = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "duplicate id in payload",
        attachmentIds: [attachmentId, attachmentId],
      }),
    });
    expect(res.status).toBe(201);

    const [row] = await db
      .select({ ticketId: attachments.ticketId, boundAt: attachments.boundAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(row?.ticketId).toBe(ticketA);
    expect(row?.boundAt).not.toBeNull();
  });

  it("allows idempotent re-reference by a DIFFERENT ticket-authorized actor than the uploader — ownership check must not re-litigate an already-settled bind", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app, CREATOR);

    const first = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "first", attachmentIds: [attachmentId] }),
    });
    expect(first.status).toBe(201);

    // READ_COMMENT_PERSON has comment access to ticketA but is NOT the
    // attachment's uploader (CREATOR is) -- re-referencing the
    // already-bound attachment must still succeed as an idempotent no-op;
    // the ownership check must not re-litigate a bind that already settled.
    const again = await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-acting-person": READ_COMMENT_PERSON,
      },
      body: JSON.stringify({
        text: "second reference to the same ticket by a different actor",
        attachmentIds: [attachmentId],
      }),
    });
    expect(again.status).toBe(201);
  });

  it("no-access person cannot bind an attachment via a comment on an inaccessible ticket", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app, NO_ACCESS_PERSON);

    const res = await app.request(`/tickets/${noAccessTicketId}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-acting-person": NO_ACCESS_PERSON,
      },
      body: JSON.stringify({ text: "sneaky", attachmentIds: [attachmentId] }),
    });
    expect(res.status).toBe(404);

    const [row] = await db
      .select({ boundAt: attachments.boundAt })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(row?.boundAt).toBeNull();
  });
});

describe("attachment references on ticket-create", () => {
  it("binds an unbound attachment presigned without a ticketId to the newly created ticket", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);

    const res = await app.request("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId,
        fields: {},
        attachmentIds: [attachmentId],
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const [row] = await db
      .select({ ticketId: attachments.ticketId })
      .from(attachments)
      .where(eq(attachments.id, attachmentId));
    expect(row?.ticketId).toBe(data.id);
  });

  it("rolls back ticket creation entirely when an attachment reference is invalid", async () => {
    const app = makeApp();
    const res = await app.request("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId,
        fields: {},
        attachmentIds: ["00000000-0000-4000-8000-000000000000"],
      }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/attachments/:id/download", () => {
  it("streams a bound, uploaded attachment for someone with ticket access", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);
    await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "attached", attachmentIds: [attachmentId] }),
    });

    const res = await app.request(`/attachments/${attachmentId}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("returns 404 for an unbound attachment (never referenced by a ticket)", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);

    const res = await app.request(`/attachments/${attachmentId}/download`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for someone with no access to the bound ticket", async () => {
    const app = makeApp();
    const attachmentId = await createUploadedAttachment(app);
    await app.request(`/tickets/${ticketA}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "attached", attachmentIds: [attachmentId] }),
    });

    const res = await app.request(`/attachments/${attachmentId}/download`, {
      headers: { "x-test-acting-person": NO_ACCESS_PERSON },
    });
    expect(res.status).toBe(404);
  });
});
