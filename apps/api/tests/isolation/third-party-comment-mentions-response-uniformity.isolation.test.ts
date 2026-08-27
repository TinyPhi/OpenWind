/**
 * Isolation tests for ADR-012 Phase C spec R6 (T8a/T8b) — the synchronous
 * POST /api/v1/tickets/:id/comments response must be identical in shape and
 * timing regardless of what any mention in the payload will eventually
 * resolve to. Mention resolution happens fully asynchronously (a BullMQ job
 * enqueued after the response is built, never awaited — see
 * mention-resolution-worker.ts) — these tests prove that decoupling holds in
 * practice, not just architecturally.
 *
 * Real Postgres + real Redis (mentionResolutionQueue.add is a genuine BullMQ
 * enqueue here, not mocked) — no resolution worker is running in this test
 * process, so jobs simply sit in the queue; only the synchronous HTTP
 * response is under test.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import { db, tenants, workflows, workflowStates } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";

const TENANT = "eeeeeeee-0000-4000-e000-000000000804";

let entityTypeId: string;
let workflowId: string;
let ticketId: string;

const CREATOR = "third-party-mention-uniformity-creator";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "3P Mention Uniformity Tenant",
    slug: `3p-mention-uniformity-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `third_party_mention_uniformity_test_${Date.now()}`,
    plural: "third_party_mention_uniformity_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Mention Uniformity Workflow",
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

  const ticket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  ticketId = ticket.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp() {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "apikey:55555555-5555-5555-5555-555555555555",
      tenantId: TENANT,
      roles: ["entity:ticket:comment"],
      email: "",
      displayName: "API Key 55555555",
      orgId: "org-eee",
    });
    c.set("actingPerson", {
      userId: CREATOR,
      email: `${CREATOR}@example.com`,
      displayName: CREATOR,
      orgId: "org-eee",
    });
    await next();
  });
  app.post("/:id/comments", ...createThirdPartyCommentHandler);
  return app;
}

async function postComment(text: string, mentions: string[]) {
  const app = makeApp();
  const start = performance.now();
  const res = await app.request(`/${ticketId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, mentions }),
  });
  const elapsedMs = performance.now() - start;
  const body = (await res.json()) as { data?: { id: string } };
  return { status: res.status, body, elapsedMs };
}

describe("POST /api/v1/tickets/:id/comments — mention response uniformity (spec R6, T8a/T8b)", () => {
  it("response shape is identical regardless of mention content — outcome-1-shaped, outcome-2-shaped, and outcome-3-shaped payloads all produce the same { data: { id } } 201", async () => {
    // "Outcome-1-shaped": mentions the ticket's own creator (would resolve to
    // already-has-access if a real resolver ran synchronously).
    const outcome1Like = await postComment("re: outcome 1", [CREATOR]);
    // "Outcome-2-shaped": a plausible tenant-user identifier with no
    // relationship to this ticket.
    const outcome2Like = await postComment("re: outcome 2", [
      "someone-else@example.com",
    ]);
    // "Outcome-3-shaped": an identifier that cannot resolve to anyone.
    const outcome3Like = await postComment("re: outcome 3", [
      "totally-unknown-identifier-xyz",
    ]);
    // No mentions at all.
    const noMentions = await postComment("re: no mentions", []);

    const results = [outcome1Like, outcome2Like, outcome3Like, noMentions];
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(Object.keys(r.body)).toEqual(["data"]);
      expect(Object.keys(r.body.data ?? {})).toEqual(["id"]);
      expect(typeof r.body.data?.id).toBe("string");
    }
  });

  it("response latency does not measurably scale with mention count or content — the response can't be leaking resolution-outcome work", async () => {
    // 20 is this endpoint's own max mentions-per-comment cap.
    const manyMentions = Array.from(
      { length: 20 },
      (_, i) => `user-${i}@example.com`,
    );

    const noneTimings: number[] = [];
    const manyTimings: number[] = [];
    for (let i = 0; i < 5; i++) {
      noneTimings.push((await postComment(`timing-none-${i}`, [])).elapsedMs);
      manyTimings.push(
        (await postComment(`timing-many-${i}`, manyMentions)).elapsedMs,
      );
    }

    const median = (arr: number[]) =>
      [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] ?? 0;
    const noneMedian = median(noneTimings);
    const manyMedian = median(manyTimings);

    // Generous bound (500ms) — this is a smoke test against a real
    // regression (e.g. someone later making the enqueue loop block on each
    // job, or synchronously resolving mentions before responding), not a
    // precise perf benchmark that would be flaky in CI.
    expect(Math.abs(manyMedian - noneMedian)).toBeLessThan(500);
  });
});
