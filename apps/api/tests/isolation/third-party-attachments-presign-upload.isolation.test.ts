/**
 * Isolation tests for POST /api/v1/attachments/presign and
 * PUT /api/v1/attachments/:id/upload (ADR-012 Phase D, Stage 1, spec R1/R2).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked) — per the
 * Phase C B1 lesson (docs/specs/third-party-api-phase-c-interaction-api.md),
 * a mocked @platform/db in this path would have hidden a real CHECK/RLS
 * failure the same way it did there.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  attachments,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { presignAttachmentHandler } from "../../src/routes/third-party/attachments-presign.js";
import { uploadAttachmentHandler } from "../../src/routes/third-party/attachments-upload.js";

const TENANT = "aabbccdd-0000-4000-a000-000000000701";
const OTHER_TENANT = "aabbccdd-0000-4000-a000-000000000702";

let entityTypeId: string;
let workflowId: string;
let accessibleTicketId: string;
let noAccessTicketId: string;
let otherTenantTicketId: string;

const CREATOR = "third-party-attachment-creator";
const NO_ACCESS_PERSON = "third-party-attachment-no-access";

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "3P Attachment Tenant", slug: `3p-attach-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "3P Attachment Other Tenant",
      slug: `3p-attach-other-${OTHER_TENANT}`,
    },
  ]);

  const entityType = await createEntityType(db, null, {
    name: `third_party_attachment_test_${Date.now()}`,
    plural: "third_party_attachment_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Attachment Workflow",
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

  const accessibleTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  accessibleTicketId = accessibleTicket.id;

  const noAccessTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  noAccessTicketId = noAccessTicket.id;

  const [otherWorkflow] = await db
    .insert(workflows)
    .values({
      tenantId: OTHER_TENANT,
      entityTypeId: (
        await createEntityType(db, null, {
          name: `third_party_attachment_other_test_${Date.now()}`,
          plural: "third_party_attachment_other_tests",
          allowCustomFields: true,
        })
      ).id,
      name: "3P Other Tenant Attachment Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id, entityTypeId: workflows.entityTypeId });
  await db.insert(workflowStates).values({
    tenantId: OTHER_TENANT,
    workflowId: otherWorkflow!.id,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });
  const otherTicket = await createEntity(db, OTHER_TENANT, {
    entityTypeId: otherWorkflow!.entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId: otherWorkflow!.id,
    currentState: "open",
  });
  otherTenantTicketId = otherTicket.id;
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
      userId: "apikey:44444444-4444-4444-4444-444444444444",
      tenantId: TENANT,
      roles: ["entity:ticket:attach"],
      email: "",
      displayName: "API Key 44444444",
      orgId: "org-fff",
    });
    c.set("actingPerson", {
      userId: actingPersonId,
      email: `${actingPersonId}@example.com`,
      displayName: actingPersonId,
      orgId: "org-fff",
    });
    await next();
  });
  app.post("/presign", ...presignAttachmentHandler);
  app.put("/:id/upload", ...uploadAttachmentHandler);
  return app;
}

async function presign(
  app: Hono<Vars>,
  body: Record<string, unknown>,
  actingPerson = CREATOR,
) {
  return app.request("/presign", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-acting-person": actingPerson,
    },
    body: JSON.stringify(body),
  });
}

async function upload(
  app: Hono<Vars>,
  attachmentId: string,
  token: string,
  bytes: Uint8Array,
) {
  return app.request(`/${attachmentId}/upload?token=${token}`, {
    method: "PUT",
    body: bytes,
  });
}

describe("POST /api/v1/attachments/presign", () => {
  it("succeeds with no ticketId (create-time-attach case) — slot stays unbound", async () => {
    const app = makeApp();
    const res = await presign(app, {
      filename: "receipt.pdf",
      sizeBytes: 1024,
      mimeType: "application/pdf",
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { attachmentId: string; uploadUrl: string; expiresAt: string };
    };
    expect(data.attachmentId).toBeTruthy();
    expect(data.uploadUrl).toContain(data.attachmentId);

    const [row] = await db
      .select({ ticketId: attachments.ticketId, status: attachments.status })
      .from(attachments)
      .where(eq(attachments.id, data.attachmentId));
    expect(row?.ticketId).toBeNull();
    expect(row?.status).toBe("pending");
  });

  it("succeeds with a ticketId the acting person has comment access to", async () => {
    const app = makeApp();
    const res = await presign(app, {
      filename: "receipt.pdf",
      sizeBytes: 1024,
      mimeType: "application/pdf",
      ticketId: accessibleTicketId,
    });
    expect(res.status).toBe(201);
  });

  it("returns 404, not 403, for a ticketId the acting person has no access to", async () => {
    const app = makeApp();
    const res = await presign(
      app,
      {
        filename: "receipt.pdf",
        sizeBytes: 1024,
        mimeType: "application/pdf",
        ticketId: noAccessTicketId,
      },
      NO_ACCESS_PERSON,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for a ticketId belonging to a different tenant", async () => {
    const app = makeApp();
    const res = await presign(app, {
      filename: "receipt.pdf",
      sizeBytes: 1024,
      mimeType: "application/pdf",
      ticketId: otherTenantTicketId,
    });
    expect(res.status).toBe(404);
  });

  it("rejects a declared size over the 10MB limit before issuing a slot", async () => {
    const app = makeApp();
    const res = await presign(app, {
      filename: "huge.zip",
      sizeBytes: 11 * 1024 * 1024,
      mimeType: "application/zip",
    });
    expect(res.status).toBe(422);
  });

  it("rejects a MIME type not in the allowlist", async () => {
    const app = makeApp();
    const res = await presign(app, {
      filename: "malware.exe",
      sizeBytes: 1024,
      mimeType: "application/x-msdownload",
    });
    expect(res.status).toBe(422);
  });
});

describe("PUT /api/v1/attachments/:id/upload", () => {
  it("completes a valid upload and transitions the slot to uploaded", async () => {
    const app = makeApp();
    const presignRes = await presign(app, {
      filename: "small.txt",
      sizeBytes: 5,
      mimeType: "text/plain",
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string; uploadUrl: string };
    };
    const token = new URL(data.uploadUrl, "http://x").searchParams.get(
      "token",
    )!;

    const res = await upload(
      app,
      data.attachmentId,
      token,
      new TextEncoder().encode("hello"),
    );
    expect(res.status).toBe(201);

    const [row] = await db
      .select({ status: attachments.status, filesId: attachments.filesId })
      .from(attachments)
      .where(eq(attachments.id, data.attachmentId));
    expect(row?.status).toBe("uploaded");
    expect(row?.filesId).toBeTruthy();
  });

  it("rejects a byte count that doesn't match the declared size", async () => {
    const app = makeApp();
    const presignRes = await presign(app, {
      filename: "small.txt",
      sizeBytes: 5,
      mimeType: "text/plain",
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string; uploadUrl: string };
    };
    const token = new URL(data.uploadUrl, "http://x").searchParams.get(
      "token",
    )!;

    const res = await upload(
      app,
      data.attachmentId,
      token,
      new TextEncoder().encode("hi"),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a replay against an already-completed slot", async () => {
    const app = makeApp();
    const presignRes = await presign(app, {
      filename: "small.txt",
      sizeBytes: 5,
      mimeType: "text/plain",
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string; uploadUrl: string };
    };
    const token = new URL(data.uploadUrl, "http://x").searchParams.get(
      "token",
    )!;

    const first = await upload(
      app,
      data.attachmentId,
      token,
      new TextEncoder().encode("hello"),
    );
    expect(first.status).toBe(201);

    const replay = await upload(
      app,
      data.attachmentId,
      token,
      new TextEncoder().encode("hello"),
    );
    expect(replay.status).toBe(409);
  });

  it("rejects an upload with the wrong token as not found", async () => {
    const app = makeApp();
    const presignRes = await presign(app, {
      filename: "small.txt",
      sizeBytes: 5,
      mimeType: "text/plain",
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string };
    };

    const res = await upload(
      app,
      data.attachmentId,
      "wrong-token",
      new TextEncoder().encode("hello"),
    );
    expect(res.status).toBe(404);
  });

  it("only one of two concurrent uploads to the same slot succeeds — no double-write", async () => {
    const app = makeApp();
    const presignRes = await presign(app, {
      filename: "small.txt",
      sizeBytes: 5,
      mimeType: "text/plain",
    });
    const { data } = (await presignRes.json()) as {
      data: { attachmentId: string; uploadUrl: string };
    };
    const token = new URL(data.uploadUrl, "http://x").searchParams.get(
      "token",
    )!;

    const [first, second] = await Promise.all([
      upload(app, data.attachmentId, token, new TextEncoder().encode("hello")),
      upload(app, data.attachmentId, token, new TextEncoder().encode("hello")),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const [row] = await db
      .select({ status: attachments.status })
      .from(attachments)
      .where(eq(attachments.id, data.attachmentId));
    expect(row?.status).toBe("uploaded");
  });

  it("rejects an upload to a nonexistent attachment id as not found", async () => {
    const app = makeApp();
    const res = await upload(
      app,
      "00000000-0000-4000-8000-000000000000",
      "any-token",
      new TextEncoder().encode("hello"),
    );
    expect(res.status).toBe(404);
  });
});
