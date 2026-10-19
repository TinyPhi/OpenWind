/**
 * #830: the outbox suppression inside sandbox module data seeding must mark the events the
 * seeding transaction wrote as delivered. It once filtered on `created_at >= <app-side date taken
 * after BEGIN>`, but an outbox row's created_at defaults to now(), which Postgres pins to the
 * start of the transaction, so that filter matched nothing and the suppression was a no-op.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, outboxEvents, withTenantContext } from "@platform/db";
import { suppressOutboxEventsWrittenByThisTransaction } from "../../src/sandbox-module-data-seed.js";

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function insertEvent(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  eventType: string,
): Promise<string> {
  const [row] = await tx
    .insert(outboxEvents)
    .values({ tenantId, eventType, version: 1, payload: {} })
    .returning({ id: outboxEvents.id });
  return row!.id;
}

async function deliveredAt(id: string): Promise<Date | null> {
  const [row] = await db
    .select({ deliveredAt: outboxEvents.deliveredAt })
    .from(outboxEvents)
    .where(eq(outboxEvents.id, id));
  return row!.deliveredAt;
}

afterAll(async () => {
  await db
    .delete(outboxEvents)
    .where(inArray(outboxEvents.tenantId, [TENANT, OTHER_TENANT]));
});

describe("suppressOutboxEventsWrittenByThisTransaction", () => {
  it("marks what the transaction wrote as delivered, even after the app clock has moved on", async () => {
    const written: string[] = [];
    await withTenantContext(TENANT, async (tx) => {
      // The seeding code does real work between BEGIN and the first write.
      await sleep(60);
      written.push(await insertEvent(tx, TENANT, "workflow.transitioned"));
      await sleep(60);
      await suppressOutboxEventsWrittenByThisTransaction(tx, TENANT);
    });

    expect(await deliveredAt(written[0]!)).not.toBeNull();
  });

  it("covers events written after an earlier call in the same transaction (per record, then per transition)", async () => {
    const ids: string[] = [];
    await withTenantContext(TENANT, async (tx) => {
      ids.push(await insertEvent(tx, TENANT, "entity.created"));
      await suppressOutboxEventsWrittenByThisTransaction(tx, TENANT);
      await sleep(30);
      ids.push(await insertEvent(tx, TENANT, "workflow.transitioned"));
      await suppressOutboxEventsWrittenByThisTransaction(tx, TENANT);
    });

    for (const id of ids) expect(await deliveredAt(id)).not.toBeNull();
  });

  it("leaves an older undelivered event of the same tenant, and other tenants' events, alone", async () => {
    const older = await withTenantContext(TENANT, (tx) =>
      insertEvent(tx, TENANT, "workflow.transitioned"),
    );
    const other = await withTenantContext(OTHER_TENANT, (tx) =>
      insertEvent(tx, OTHER_TENANT, "workflow.transitioned"),
    );
    await sleep(20);

    await withTenantContext(TENANT, async (tx) => {
      await insertEvent(tx, TENANT, "workflow.transitioned");
      await suppressOutboxEventsWrittenByThisTransaction(tx, TENANT);
    });

    expect(await deliveredAt(older)).toBeNull();
    expect(await deliveredAt(other)).toBeNull();
  });
});
