/**
 * mention-resolution-worker.test.ts
 *
 * Unit tests for the mention-resolution BullMQ processor (ADR-012 Phase C,
 * spec R4/R5/R6/R7). DB, Zitadel, and Redis are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Capture the processor + failure handler passed to Worker ───────────────────

type JobLike = {
  data: Record<string, unknown>;
  id: string;
  attemptsMade: number;
  opts: { attempts?: number };
};

let capturedProcessor: ((job: JobLike) => Promise<void>) | undefined;
let capturedFailedHandler:
  | ((job: JobLike | undefined, err: Error) => void)
  | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: JobLike) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return {
      on: vi.fn((event: string, handler: typeof capturedFailedHandler) => {
        if (event === "failed") capturedFailedHandler = handler;
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── DB mock: sequential select queue (same convention as workflow-crud.test.ts) ─

let selectQueue: Array<() => unknown[]> = [];
let selectCallIndex = 0;

function nextSelect() {
  const fn = selectQueue[selectCallIndex++] ?? (() => []);
  const q: Record<string, unknown> = {};
  q["from"] = () => q;
  q["where"] = () => q;
  q["limit"] = () => Promise.resolve(fn());
  return q;
}

const insertCalls: Array<{ table: unknown; values: unknown }> = [];
let onConflictReturning: unknown[] = [{ id: "req-1" }];
let mockUpdateReturning: unknown[] = [{ id: "instance-1" }];
const updateCalls: Array<{ table: unknown; setVals: unknown }> = [];

const mockTx = {
  select: () => nextSelect(),
  insert: (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(onConflictReturning),
        }),
      };
    },
  }),
  update: (table: unknown) => ({
    set: (setVals: unknown) => {
      updateCalls.push({ table, setVals });
      return {
        where: () => ({
          returning: () => Promise.resolve(mockUpdateReturning),
        }),
      };
    },
  }),
};

vi.mock("@platform/db", () => ({
  entityInstances: "entity_instances_mock",
  workflows: "workflows_mock",
  accessRequests: { id: "access_requests.id" },
  outboxEvents: "outbox_events_mock",
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  isTenantActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...args) => ({ args, op: "and" })),
  isNull: vi.fn((col) => ({ col, op: "isNull" })),
  sql: vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({
    strings,
    vals,
  })),
}));

// ── Zitadel / auth mock ──────────────────────────────────────────────────────

let mockOrgUsers: Array<{
  userId: string;
  email: string;
  displayName: string;
  loginName: string;
  phone: undefined;
}> = [];
let mockRolesByUserId = new Map<string, string[]>();

vi.mock("@platform/auth", () => ({
  listOrgUsers: vi.fn(() => Promise.resolve(mockOrgUsers)),
  listUserRolesByUserId: vi.fn(() => Promise.resolve(mockRolesByUserId)),
}));

// ── hasEntityAccess / emitAccessEvent mocks ─────────────────────────────────

let mockHasEntityAccess = false;
const emitAccessEventCalls: Array<{
  tenantId: string;
  instanceId: string;
  actorId: string;
  payload: unknown;
}> = [];
vi.mock("@platform/workflow-engine", () => ({
  hasEntityAccess: vi.fn(() => Promise.resolve(mockHasEntityAccess)),
  emitAccessEvent: vi.fn(
    (
      tenantId: string,
      instanceId: string,
      actorId: string,
      payload: unknown,
    ) => {
      emitAccessEventCalls.push({ tenantId, instanceId, actorId, payload });
      return Promise.resolve();
    },
  ),
}));

// ── Audit mock ───────────────────────────────────────────────────────────────

const auditEntries: Array<{ action: string; metadata?: unknown }> = [];
vi.mock("@platform/audit", () => ({
  writeAuditEntry: vi.fn(
    (_tx: unknown, input: { action: string; metadata?: unknown }) => {
      auditEntries.push({ action: input.action, metadata: input.metadata });
      return Promise.resolve();
    },
  ),
}));

// ── Redis mock ───────────────────────────────────────────────────────────────

let mockRateLimitAllowed = true;
vi.mock("@platform/redis", () => ({
  checkRateLimit: vi.fn(() =>
    Promise.resolve({
      allowed: mockRateLimitAllowed,
      remaining: 0,
      resetAt: 0,
    }),
  ),
  getRedis: vi.fn(() => ({})),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Notifications mock ───────────────────────────────────────────────────────

const misuseAlertCalls: Array<{ reason: string; context: unknown }> = [];
vi.mock("@platform/notifications", () => ({
  fireMisuseAlert: vi.fn(
    (_tx: unknown, _tenantId: string, reason: string, context: unknown) => {
      misuseAlertCalls.push({ reason, context });
      return Promise.resolve();
    },
  ),
}));

vi.mock("./queues.js", () => ({ connection: {} }));

const { stopMentionResolutionWorker } =
  await import("./mention-resolution-worker.js");
void stopMentionResolutionWorker; // exercised only for import-side-effect coverage

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-1";
const TICKET_ID = "ticket-1";
const WORKFLOW_ID = "workflow-1";
const ORG_ID = "org-1";
const ACTING_PERSON_ID = "acting-person-1";
const COMMENT_ID = "comment-1";
const MENTIONED_USER_ID = "mentioned-user-1";
const MENTIONED_EMAIL = "mentioned@example.com";

const instanceRow = {
  id: TICKET_ID,
  workflowId: WORKFLOW_ID,
  createdBy: "creator-1",
  assignedTo: null,
  fields: {},
};

function baseJob(overrides: Partial<JobLike["data"]> = {}): JobLike {
  return {
    id: "job-1",
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: {
      tenantId: TENANT_ID,
      orgId: ORG_ID,
      ticketId: TICKET_ID,
      workflowId: WORKFLOW_ID,
      mentionIdentifier: MENTIONED_EMAIL,
      actingPersonId: ACTING_PERSON_ID,
      commentId: COMMENT_ID,
      ...overrides,
    },
  };
}

beforeEach(() => {
  selectQueue = [];
  selectCallIndex = 0;
  insertCalls.length = 0;
  updateCalls.length = 0;
  auditEntries.length = 0;
  emitAccessEventCalls.length = 0;
  misuseAlertCalls.length = 0;
  onConflictReturning = [{ id: "req-1" }];
  mockOrgUsers = [
    {
      userId: MENTIONED_USER_ID,
      email: MENTIONED_EMAIL,
      displayName: "Mentioned Person",
      loginName: MENTIONED_EMAIL,
      phone: undefined,
    },
  ];
  mockRolesByUserId = new Map([[MENTIONED_USER_ID, ["user"]]]);
  mockHasEntityAccess = false;
  mockRateLimitAllowed = true;
  mockUpdateReturning = [{ id: "instance-1" }];
});

describe("mention-resolution-worker", () => {
  it("outcome 1: already has ticket access — logs tag.resolved_existing_access, no grant/request", async () => {
    selectQueue = [() => [instanceRow]];
    mockHasEntityAccess = true;

    await capturedProcessor!(baseJob());

    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.resolved_existing_access" }),
    ]);
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  it("outcome 3: identifier doesn't resolve to any org user — logs tag.fallback", async () => {
    selectQueue = [() => [instanceRow]];
    mockOrgUsers = [];

    await capturedProcessor!(
      baseJob({ mentionIdentifier: "nobody@example.com" }),
    );

    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.fallback" }),
    ]);
  });

  it("outcome 3: identifier resolves but the person doesn't hold the 'user' role — logs tag.fallback", async () => {
    selectQueue = [() => [instanceRow]];
    mockRolesByUserId = new Map([[MENTIONED_USER_ID, ["agent"]]]);

    await capturedProcessor!(baseJob());

    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.fallback" }),
    ]);
  });

  it("outcome 2, toggle OFF (default): creates an access-request + notification outbox event, logs tag.access_request_created", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: false }],
    ];
    mockHasEntityAccess = false;

    await capturedProcessor!(baseJob());

    expect(insertCalls).toHaveLength(2); // access_requests + outbox_events
    expect(
      (insertCalls[0]?.values as { requesterId: string }).requesterId,
    ).toBe(MENTIONED_USER_ID);
    expect(insertCalls[1]?.table).toBe("outbox_events_mock");
    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.access_request_created" }),
    ]);
  });

  it("outcome 2, toggle OFF: does not emit the notification outbox event when the insert conflicts (already-pending request)", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: false }],
    ];
    onConflictReturning = [];

    await capturedProcessor!(baseJob());

    expect(insertCalls).toHaveLength(1); // access_requests only, no outbox row
    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.access_request_created" }),
    ]);
  });

  it("outcome 2, toggle ON, under the rate cap: auto-grants read-only and logs tag.auto_granted", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: true }],
    ];
    mockRateLimitAllowed = true;

    await capturedProcessor!(baseJob());

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.table).toBe("entity_instances_mock");
    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.auto_granted" }),
    ]);
  });

  it("outcome 2, toggle ON, under the rate cap: emits an access_grant event so the granted user gets a timeline entry and notification — PR #470 review finding 1", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: true }],
    ];
    mockRateLimitAllowed = true;

    await capturedProcessor!(baseJob());

    expect(emitAccessEventCalls).toEqual([
      {
        tenantId: TENANT_ID,
        instanceId: TICKET_ID,
        actorId: ACTING_PERSON_ID,
        payload: {
          type: "access_grant",
          targetUserId: MENTIONED_USER_ID,
          level: "read_only",
          tag: "mention",
        },
      },
    ]);
  });

  it("outcome 2, toggle ON, over the rate cap: does not emit an access_grant event since no grant happened", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: true }],
    ];
    mockRateLimitAllowed = false;

    await capturedProcessor!(baseJob());

    expect(emitAccessEventCalls).toHaveLength(0);
  });

  it("a stalled-job replay after the grant already committed resolves to outcome 1, not a second auto-grant — never double-fires emitAccessEvent/tag.auto_granted", async () => {
    // Every job run does a fresh SELECT of the instance (line ~115) and
    // recomputes `outcome` from whatever it finds — it never trusts stale
    // in-memory state from a prior attempt. Once a grant has actually
    // committed, hasEntityAccess (real implementation) reads read_only from
    // __accessUsers and returns true for the granted user, so a replay
    // lands on outcome 1 ("already has access") long before it could reach
    // the auto-grant/emitAccessEvent branch a second time. This test
    // simulates exactly that post-commit replay via the same
    // mockHasEntityAccess toggle outcome-1's own test above uses.
    selectQueue = [() => [instanceRow]];
    mockHasEntityAccess = true;

    await capturedProcessor!(baseJob());

    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.resolved_existing_access" }),
    ]);
    expect(updateCalls).toHaveLength(0);
    expect(emitAccessEventCalls).toHaveLength(0);
  });

  it("outcome 2, toggle ON, over the rate cap: does not grant, logs tag.misuse_rate_capped instead", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: true }],
    ];
    mockRateLimitAllowed = false;

    await capturedProcessor!(baseJob());

    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.misuse_rate_capped" }),
    ]);
    // ADR-012 Phase F, spec R4 trigger 3 -- fires through the same
    // fireMisuseAlert channel as triggers 1/2.
    expect(misuseAlertCalls).toHaveLength(1);
    expect(misuseAlertCalls[0]?.context).toEqual(
      expect.objectContaining({ trigger: "tagging_grant_cap" }),
    );
  });

  it("ticket not found: returns early, no audit entry written", async () => {
    selectQueue = [() => []];

    await capturedProcessor!(baseJob());

    expect(auditEntries).toHaveLength(0);
  });

  it("soft-deleted ticket (returns empty instance fetch): returns early and does not audit or grant", async () => {
    // Select returns empty array representing that the ticket is soft-deleted/missing due to the isNull(deletedAt) filter
    selectQueue = [() => []];

    await capturedProcessor!(baseJob());

    expect(updateCalls).toHaveLength(0);
    expect(auditEntries).toHaveLength(0);
    expect(emitAccessEventCalls).toHaveLength(0);
  });

  it("outcome 2, toggle ON, under the rate cap but UPDATE matches 0 rows (soft-deleted mid-transaction race): does not audit or emit grant event", async () => {
    selectQueue = [
      () => [instanceRow],
      () => [{ allowAutoGrantOnMention: true }],
    ];
    mockRateLimitAllowed = true;
    mockUpdateReturning = []; // UPDATE matches 0 rows (e.g. ticket was soft-deleted after select but before update)

    await capturedProcessor!(baseJob());

    expect(updateCalls).toHaveLength(1);
    expect(auditEntries).toHaveLength(0); // no tag.auto_granted audit written
    expect(emitAccessEventCalls).toHaveLength(0); // no timeline event or outbox notification
  });

  it("on final-attempt failure, writes a tag.resolution_failed audit entry", async () => {
    const job = baseJob();
    job.attemptsMade = 3;
    job.opts = { attempts: 3 };

    capturedFailedHandler!(job, new Error("boom"));
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget audit write settle

    expect(auditEntries).toEqual([
      expect.objectContaining({ action: "tag.resolution_failed" }),
    ]);
  });

  it("does not write a resolution_failed entry when retries remain", async () => {
    const job = baseJob();
    job.attemptsMade = 1;
    job.opts = { attempts: 3 };

    capturedFailedHandler!(job, new Error("transient"));
    await new Promise((r) => setTimeout(r, 0));

    expect(auditEntries).toHaveLength(0);
  });
});
