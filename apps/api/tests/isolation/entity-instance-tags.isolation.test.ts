/**
 * Tenant isolation + constraint tests for the entity_instance_tags table and the
 * entity_instances.severity column (docs/specs/ticket-severity-and-tags.md, Phase 1).
 *
 * Two isolation layers tested here, same pattern as ticket_alerts:
 *  1. Explicit WHERE tenant_id = $tenantId (layer 1 — primary guard).
 *  2. Postgres RLS policy `entity_instance_tags_tenant_isolation` (layer 2 — enforced
 *     via SET LOCAL ROLE app_user inside withTenantContext, per #121/#122).
 *
 * Also covers the DB-level composite uniqueness constraint
 * (tenant_id, entity_instance_id, tag_text) that backs the spec's per-ticket
 * exact-duplicate rejection (§V — "not just an application-level pre-check"), and the
 * entity_instances.severity CHECK constraint.
 *
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import {
  db,
  withTenantContext,
  tenants,
  entityInstances,
  entityInstanceTags,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";

const TENANT_A = "cccccccc-0042-4000-c000-000000000042";
const TENANT_B = "dddddddd-0042-4000-d000-000000000042";

let instanceA: string;
let instanceB: string;
let tagAId: string;
let tagBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation Tenant A (tags)",
      slug: `isolation-tags-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Isolation Tenant B (tags)",
      slug: `isolation-tags-b-${Date.now()}`,
    },
  ]);

  const typeA = await createEntityType(db, null, {
    name: `isolation_tags_ticket_a_${Date.now()}`,
    plural: "isolation_tags_tickets_a",
    allowCustomFields: true,
  });
  const typeB = await createEntityType(db, null, {
    name: `isolation_tags_ticket_b_${Date.now()}`,
    plural: "isolation_tags_tickets_b",
    allowCustomFields: true,
  });

  const a = await createEntity(db, TENANT_A, {
    entityTypeId: typeA.id,
    fields: {},
    createdBy: "user-a",
  });
  const b = await createEntity(db, TENANT_B, {
    entityTypeId: typeB.id,
    fields: {},
    createdBy: "user-b",
  });
  instanceA = a.id;
  instanceB = b.id;

  // Insert via withTenantContext (SET LOCAL ROLE app_user) — proves the GRANT in
  // migration 0092 is present, same #10-class bug class as access_requests/ticket_alerts.
  const [rowA] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(entityInstanceTags)
      .values({
        tenantId: TENANT_A,
        entityInstanceId: instanceA,
        tagText: "railways",
        createdBy: "user-a",
      })
      .returning({ id: entityInstanceTags.id }),
  );
  const [rowB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(entityInstanceTags)
      .values({
        tenantId: TENANT_B,
        entityInstanceId: instanceB,
        tagText: "railways",
        createdBy: "user-b",
      })
      .returning({ id: entityInstanceTags.id }),
  );
  tagAId = rowA!.id;
  tagBId = rowB!.id;
});

afterAll(async () => {
  await db
    .delete(entityInstanceTags)
    .where(eq(entityInstanceTags.tenantId, TENANT_A));
  await db
    .delete(entityInstanceTags)
    .where(eq(entityInstanceTags.tenantId, TENANT_B));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_A));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_B));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("entity_instance_tags — app_user GRANT (migration 0092)", () => {
  it("INSERT via withTenantContext succeeds against real Postgres+RLS", () => {
    expect(tagAId).toBeDefined();
    expect(tagBId).toBeDefined();
  });

  it("DELETE via withTenantContext succeeds (matches GRANT SELECT, INSERT, DELETE)", async () => {
    const deleted = await withTenantContext(TENANT_A, (tx) =>
      tx
        .delete(entityInstanceTags)
        .where(
          and(
            eq(entityInstanceTags.id, tagAId),
            eq(entityInstanceTags.tenantId, TENANT_A),
          ),
        )
        .returning({ id: entityInstanceTags.id }),
    );
    expect(deleted).toHaveLength(1);

    // restore for the remaining tests in this suite
    const [restored] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(entityInstanceTags)
        .values({
          tenantId: TENANT_A,
          entityInstanceId: instanceA,
          tagText: "railways",
          createdBy: "user-a",
        })
        .returning({ id: entityInstanceTags.id }),
    );
    tagAId = restored!.id;
  });
});

describe("entity_instance_tags — cross-tenant READ isolation (layer 1: explicit filter)", () => {
  it("query scoped to Tenant A never returns Tenant B's tag id", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ id: entityInstanceTags.id })
        .from(entityInstanceTags)
        .where(
          and(
            eq(entityInstanceTags.id, tagBId),
            eq(entityInstanceTags.tenantId, TENANT_A),
          ),
        ),
    );
    expect(rows).toHaveLength(0);
  });

  it("query scoped to Tenant B never returns Tenant A's tag id", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx
        .select({ id: entityInstanceTags.id })
        .from(entityInstanceTags)
        .where(
          and(
            eq(entityInstanceTags.id, tagAId),
            eq(entityInstanceTags.tenantId, TENANT_B),
          ),
        ),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("entity_instance_tags — RLS enforcement independent of explicit filter (layer 2)", () => {
  it("a query with the app.tenant_id GUC set to Tenant A returns 0 rows for Tenant B's tag, even with no WHERE tenant_id clause", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM entity_instance_tags WHERE id = ${tagBId}`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("a query with the app.tenant_id GUC set to Tenant B returns 0 rows for Tenant A's tag, even with no WHERE tenant_id clause", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM entity_instance_tags WHERE id = ${tagAId}`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("WITH CHECK rejects an INSERT whose tenant_id doesn't match the active app.tenant_id GUC", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.execute(
          sql`INSERT INTO entity_instance_tags (tenant_id, entity_instance_id, tag_text, created_by)
              VALUES (${TENANT_B}, ${instanceB}, 'cross-tenant-write-attempt', 'attacker')`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("entity_instance_tags — composite uniqueness (tenant_id, entity_instance_id, tag_text)", () => {
  it("rejects a second identical normalized tag on the same ticket at the DB level", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(entityInstanceTags).values({
          tenantId: TENANT_A,
          entityInstanceId: instanceA,
          tagText: "railways",
          createdBy: "user-a-second-attempt",
        }),
      ),
    ).rejects.toThrow();
  });

  it("allows the same tag text on a different ticket within the same tenant", async () => {
    const secondInstance = await createEntity(db, TENANT_A, {
      entityTypeId: (
        await createEntityType(db, null, {
          name: `isolation_tags_ticket_a2_${Date.now()}`,
          plural: "isolation_tags_tickets_a2",
          allowCustomFields: true,
        })
      ).id,
      fields: {},
      createdBy: "user-a",
    });

    const [row] = await withTenantContext(TENANT_A, (tx) =>
      tx
        .insert(entityInstanceTags)
        .values({
          tenantId: TENANT_A,
          entityInstanceId: secondInstance.id,
          tagText: "railways",
          createdBy: "user-a",
        })
        .returning({ id: entityInstanceTags.id }),
    );
    expect(row).toBeDefined();

    await db
      .delete(entityInstanceTags)
      .where(eq(entityInstanceTags.entityInstanceId, secondInstance.id));
    await db
      .delete(entityInstances)
      .where(eq(entityInstances.id, secondInstance.id));
  });

  it("rejects an empty or over-length tag_text at the DB level", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(entityInstanceTags).values({
          tenantId: TENANT_A,
          entityInstanceId: instanceA,
          tagText: "",
          createdBy: "user-a",
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(entityInstanceTags).values({
          tenantId: TENANT_A,
          entityInstanceId: instanceA,
          tagText: "x".repeat(51),
          createdBy: "user-a",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("entity_instances.severity — CHECK constraint (migration 0092)", () => {
  it("accepts each of the four fixed severity values", async () => {
    for (const value of ["low", "medium", "high", "critical"] as const) {
      await db
        .update(entityInstances)
        .set({ severity: value })
        .where(eq(entityInstances.id, instanceA));
      const [row] = await db
        .select({ severity: entityInstances.severity })
        .from(entityInstances)
        .where(eq(entityInstances.id, instanceA));
      expect(row!.severity).toBe(value);
    }
  });

  it("rejects a value outside the fixed severity set at the DB level", async () => {
    await expect(
      db.execute(
        sql`UPDATE entity_instances SET severity = 'urgent' WHERE id = ${instanceA}`,
      ),
    ).rejects.toThrow();
  });

  it("a pre-existing row (created before this feature) has severity = NULL by default", async () => {
    const preExisting = await createEntity(db, TENANT_A, {
      entityTypeId: (
        await createEntityType(db, null, {
          name: `isolation_tags_preexisting_${Date.now()}`,
          plural: "isolation_tags_preexisting",
          allowCustomFields: true,
        })
      ).id,
      fields: {},
      createdBy: "user-a",
    });
    expect(preExisting.severity).toBeNull();

    await db
      .delete(entityInstances)
      .where(eq(entityInstances.id, preExisting.id));
  });
});
