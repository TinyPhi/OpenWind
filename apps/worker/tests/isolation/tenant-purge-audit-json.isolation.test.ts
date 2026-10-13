/**
 * #860 / docs/specs/audit-log-json-anonymization.md -- a tenant purge must
 * also replace person identifiers held in admin_audit_log's JSON columns
 * (metadata, before_snapshot, after_snapshot), found by value, not by path.
 *
 * Real Postgres; the purge processor is invoked directly (only BullMQ is
 * mocked), so this also proves the ordering: the member below never acts, so
 * their id exists only in tenant_users, which the purge deletes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tenants, tenantUsers, adminAuditLog } from "@platform/db";
import { anonymizeAuditLogForTenant } from "@platform/audit";

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const TENANT = "ffffffff-0860-4000-a000-000000000001";
const BYSTANDER = "ffffffff-0860-4000-b000-000000000002";
const RESOURCE = "ffffffff-0860-4000-a000-000000000009";
const ACTOR = "u-860-actor";
const MEMBER_ONLY = "u-860-member-only";
const MEMBER_EMAIL = "Member.Only@Example.com";
const FORMER = "u-860-former-member";
const SHORT = "ab";

type Row = typeof adminAuditLog.$inferInsert;
const row = (tenantId: string, extra: Partial<Row>): Row => ({
  tenantId,
  actorId: "system",
  actorType: "system",
  resourceType: "ticket",
  resourceId: RESOURCE,
  action: "updated",
  ...extra,
});

const ids: Record<string, string> = {};
async function insert(key: string, r: Row): Promise<void> {
  const [out] = await db
    .insert(adminAuditLog)
    .values(r)
    .returning({ id: adminAuditLog.id });
  if (!out) throw new Error(`seed ${key} failed`);
  ids[key] = out.id;
}
async function load(key: string) {
  const [r] = await db
    .select()
    .from(adminAuditLog)
    .where(eq(adminAuditLog.id, ids[key] ?? ""));
  return r;
}

beforeAll(async () => {
  for (const [id, status] of [
    [TENANT, "deleted"],
    [BYSTANDER, "active"],
  ] as const) {
    await db
      .insert(tenants)
      .values({ id, name: `#860 ${id}`, slug: `audit-json-${id}`, status })
      .onConflictDoNothing();
  }
  // A member who never acts: their id is in tenant_users only.
  await db.insert(tenantUsers).values([
    { tenantId: TENANT, userId: MEMBER_ONLY, email: MEMBER_EMAIL },
    { tenantId: BYSTANDER, userId: MEMBER_ONLY, email: MEMBER_EMAIL },
  ]);

  await insert(
    "targetOnly",
    row(TENANT, {
      action: "created",
      metadata: { targetUserId: MEMBER_ONLY, role: "agent" },
    }),
  );
  await insert(
    "nested",
    row(TENANT, {
      actorId: ACTOR,
      actorType: "user",
      beforeSnapshot: { assignedTo: [MEMBER_ONLY, "someone-else"], n: 1 },
      afterSnapshot: {
        deep: { list: [{ primaryUserId: ACTOR }], [FORMER]: "key" },
      },
    }),
  );
  await insert(
    "email",
    row(TENANT, { metadata: { granted: "member.only@example.com" } }),
  );
  await insert(
    "former",
    row(TENANT, {
      actorId: FORMER,
      actorType: "user",
      metadata: { note: `${FORMER}-suffix`, ref: FORMER },
    }),
  );
  await insert("short", row(TENANT, { metadata: { v: SHORT } }));
  await insert("clean", row(TENANT, { metadata: { status: "ok", n: 3 } }));
  await insert(
    "bystander",
    row(BYSTANDER, { metadata: { targetUserId: MEMBER_ONLY } }),
  );

  await import("../../src/tenant-purge.js");
});

afterAll(async () => {
  for (const t of [TENANT, BYSTANDER]) {
    await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, t));
    await db.delete(tenantUsers).where(eq(tenantUsers.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
});

describe("tenant purge scrubs person identifiers from audit JSON (#860)", () => {
  it("purges the tenant", async () => {
    expect(capturedProcessor).not.toBeNull();
    await capturedProcessor!({
      id: "audit-json-860",
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { tenantId: TENANT },
    });
    const [t] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, TENANT));
    expect(t?.status).toBe("purged");
  });

  it("scrubs the id of a member who never acted (only tenant_users knew it)", async () => {
    expect((await load("targetOnly"))?.metadata).toEqual({
      targetUserId: "[REDACTED]",
      role: "agent",
    });
  });

  it("scrubs ids nested in snapshots, in arrays and as object keys, and keeps everything else", async () => {
    const r = await load("nested");
    expect(r?.actorId).toBe("[REDACTED]");
    expect(r?.beforeSnapshot).toEqual({
      assignedTo: ["[REDACTED]", "someone-else"],
      n: 1,
    });
    expect(r?.afterSnapshot).toEqual({
      deep: { list: [{ primaryUserId: "[REDACTED]" }], "[REDACTED]": "key" },
    });
  });

  it("scrubs an email whatever its case", async () => {
    expect((await load("email"))?.metadata).toEqual({ granted: "[REDACTED]" });
  });

  it("scrubs the id of someone who acted but is no longer a member, and leaves a longer string alone", async () => {
    expect((await load("former"))?.metadata).toEqual({
      note: `${FORMER}-suffix`,
      ref: "[REDACTED]",
    });
  });

  it("ignores values shorter than the minimum identifier length", async () => {
    expect((await load("short"))?.metadata).toEqual({ v: SHORT });
  });

  it("keeps aggregate fields and untouched rows as they were", async () => {
    const r = await load("targetOnly");
    expect(r?.action).toBe("created");
    expect(r?.resourceType).toBe("ticket");
    expect(r?.resourceId).toBe(RESOURCE);
    expect((await load("clean"))?.metadata).toEqual({ status: "ok", n: 3 });
  });

  it("does not touch another tenant's row that holds the same id", async () => {
    expect((await load("bystander"))?.metadata).toEqual({
      targetUserId: MEMBER_ONLY,
    });
  });

  it("is idempotent: a second run changes nothing", async () => {
    const before = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT));
    await anonymizeAuditLogForTenant(db, TENANT);
    const after = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT));
    expect(after).toEqual(before);
  });
});
