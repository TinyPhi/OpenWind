/**
 * Isolation + behavior tests for Phase 2 of docs/specs/ticket-severity-and-tags.md
 * (T6-T11) -- the entity-engine functions the route layer calls:
 * setEntityInstanceSeverity, addEntityInstanceTag, removeEntityInstanceTag, and
 * listEntities' new severity/tag filters.
 *
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenantContext, tenants, entityInstances } from "@platform/db";
import {
  createEntityType,
  createEntity,
  setEntityInstanceSeverity,
  addEntityInstanceTag,
  removeEntityInstanceTag,
  listEntities,
  EntityError,
  ValidationError,
} from "@platform/entity-engine";

const TENANT_A = "eeeeeeee-0042-4000-e000-000000000042";
const TENANT_B = "ffffffff-0042-4000-f000-000000000042";

let entityTypeIdA: string;
let instanceAId: string;
let instanceBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation Tenant A (severity/tags phase2)",
      slug: `isolation-sevtags-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Isolation Tenant B (severity/tags phase2)",
      slug: `isolation-sevtags-b-${Date.now()}`,
    },
  ]);

  const typeA = await createEntityType(db, null, {
    name: `isolation_sevtags_ticket_a_${Date.now()}`,
    plural: "isolation_sevtags_tickets_a",
    allowCustomFields: true,
  });
  const typeB = await createEntityType(db, null, {
    name: `isolation_sevtags_ticket_b_${Date.now()}`,
    plural: "isolation_sevtags_tickets_b",
    allowCustomFields: true,
  });
  entityTypeIdA = typeA.id;

  const a = await createEntity(db, TENANT_A, {
    entityTypeId: typeA.id,
    fields: {},
    createdBy: "user-a",
    severity: "medium",
  });
  const b = await createEntity(db, TENANT_B, {
    entityTypeId: typeB.id,
    fields: {},
    createdBy: "user-b",
    severity: "medium",
  });
  instanceAId = a.id;
  instanceBId = b.id;
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_A));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.tenantId, TENANT_B));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("setEntityInstanceSeverity", () => {
  it("updates severity and returns the previous value", async () => {
    const result = await withTenantContext(TENANT_A, (tx) =>
      setEntityInstanceSeverity(tx, TENANT_A, instanceAId, "high"),
    );
    expect(result.previousSeverity).toBe("medium");
    expect(result.instance.severity).toBe("high");
  });

  it("throws ENTITY_NOT_FOUND for a cross-tenant instance id", async () => {
    await expect(
      withTenantContext(TENANT_B, (tx) =>
        setEntityInstanceSeverity(tx, TENANT_B, instanceAId, "critical"),
      ),
    ).rejects.toThrow(EntityError);
  });
});

describe("addEntityInstanceTag / removeEntityInstanceTag", () => {
  it("normalizes tag text (trim + lowercase) on add", async () => {
    const tag = await withTenantContext(TENANT_A, (tx) =>
      addEntityInstanceTag(tx, TENANT_A, instanceAId, "  Railways  ", "user-a"),
    );
    expect(tag.tagText).toBe("railways");
  });

  it("rejects an exact-duplicate normalized tag on the same ticket", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        addEntityInstanceTag(tx, TENANT_A, instanceAId, "railways", "user-a"),
      ),
    ).rejects.toMatchObject({ code: "TAG_ALREADY_EXISTS" });
  });

  it("rejects an empty tag after normalization", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        addEntityInstanceTag(tx, TENANT_A, instanceAId, "   ", "user-a"),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a tag over 50 characters after normalization", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        addEntityInstanceTag(
          tx,
          TENANT_A,
          instanceAId,
          "x".repeat(51),
          "user-a",
        ),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("throws ENTITY_NOT_FOUND when the instance id belongs to another tenant", async () => {
    await expect(
      withTenantContext(TENANT_B, (tx) =>
        addEntityInstanceTag(
          tx,
          TENANT_B,
          instanceAId,
          "cross-tenant",
          "user-b",
        ),
      ),
    ).rejects.toThrow(EntityError);
  });

  it("creator-lock: a non-creator cannot remove without admin override", async () => {
    const tag = await withTenantContext(TENANT_A, (tx) =>
      addEntityInstanceTag(tx, TENANT_A, instanceAId, "urgent", "user-a"),
    );
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        removeEntityInstanceTag(
          tx,
          TENANT_A,
          instanceAId,
          tag.id,
          "user-other",
          false,
        ),
      ),
    ).rejects.toMatchObject({ code: "TAG_FORBIDDEN" });
  });

  it("admin override allows a non-creator to remove the tag", async () => {
    const tag = await withTenantContext(TENANT_A, (tx) =>
      addEntityInstanceTag(tx, TENANT_A, instanceAId, "override-me", "user-a"),
    );
    const removed = await withTenantContext(TENANT_A, (tx) =>
      removeEntityInstanceTag(
        tx,
        TENANT_A,
        instanceAId,
        tag.id,
        "admin-user",
        true,
      ),
    );
    expect(removed.id).toBe(tag.id);
    expect(removed.createdBy).toBe("user-a");
  });

  it("the tag's own creator can remove it without admin override", async () => {
    const tag = await withTenantContext(TENANT_A, (tx) =>
      addEntityInstanceTag(
        tx,
        TENANT_A,
        instanceAId,
        "self-removable",
        "user-a",
      ),
    );
    const removed = await withTenantContext(TENANT_A, (tx) =>
      removeEntityInstanceTag(
        tx,
        TENANT_A,
        instanceAId,
        tag.id,
        "user-a",
        false,
      ),
    );
    expect(removed.id).toBe(tag.id);
  });

  it("throws TAG_NOT_FOUND for a tag id scoped to another tenant", async () => {
    const tagInB = await withTenantContext(TENANT_B, (tx) =>
      addEntityInstanceTag(tx, TENANT_B, instanceBId, "b-only-tag", "user-b"),
    );
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        removeEntityInstanceTag(
          tx,
          TENANT_A,
          instanceAId,
          tagInB.id,
          "user-a",
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: "TAG_NOT_FOUND" });
  });
});

describe("listEntities — severity and tag filters", () => {
  it("severity filter returns only matching-severity instances (OR across levels)", async () => {
    const critical = await createEntity(db, TENANT_A, {
      entityTypeId: entityTypeIdA,
      fields: {},
      createdBy: "user-a",
      severity: "critical",
    });

    const page = await withTenantContext(TENANT_A, (tx) =>
      listEntities(tx, TENANT_A, {
        entityTypeId: entityTypeIdA,
        severity: ["critical"],
      }),
    );
    const ids = page.data.map((r) => r.id);
    expect(ids).toContain(critical.id);
    expect(ids).not.toContain(instanceAId); // instanceA is "high" by this point

    await db.delete(entityInstances).where(eq(entityInstances.id, critical.id));
  });

  it("tag filter returns only instances carrying that exact normalized tag", async () => {
    const tagged = await createEntity(db, TENANT_A, {
      entityTypeId: entityTypeIdA,
      fields: {},
      createdBy: "user-a",
      severity: "medium",
    });
    await withTenantContext(TENANT_A, (tx) =>
      addEntityInstanceTag(tx, TENANT_A, tagged.id, "findme", "user-a"),
    );

    const page = await withTenantContext(TENANT_A, (tx) =>
      listEntities(tx, TENANT_A, {
        entityTypeId: entityTypeIdA,
        tag: "findme",
      }),
    );
    const ids = page.data.map((r) => r.id);
    expect(ids).toEqual([tagged.id]);

    await db.delete(entityInstances).where(eq(entityInstances.id, tagged.id));
  });

  it("tag filter never returns another tenant's instance even with a matching tag", async () => {
    const page = await withTenantContext(TENANT_A, (tx) =>
      listEntities(tx, TENANT_A, {
        entityTypeId: entityTypeIdA,
        tag: "b-only-tag",
      }),
    );
    expect(page.data).toHaveLength(0);
  });
});
