/**
 * Tenant isolation tests for the entity engine.
 *
 * These tests use a real Postgres database (no mocks) to verify that cross-tenant
 * data leakage is impossible across every public entity engine API surface.
 * Two isolated test tenants (A and B) are created per suite run and torn down
 * after all tests complete.
 *
 * Isolation is enforced by two layers:
 *  1. Explicit WHERE tenant_id = $tenantId conditions in every engine query.
 *  2. Postgres RLS policies (when the connection role has RLS enforced).
 *
 * These tests exercise layer 1 exhaustively and exercise layer 2 via
 * withTenantContext, which sets app.tenant_id for the transaction.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, withTenantContext } from "@platform/db";
import { entityInstances, entityTypes, entityRelations } from "@platform/db";
import {
  createEntityType,
  getEntityType,
  createEntity,
  getEntity,
  updateEntity,
  deleteEntity,
  setEntityState,
  listEntities,
  createRelation,
  listRelations,
  searchEntities,
  bulkUpdateEntities,
  bulkSetState,
  EntityError,
} from "@platform/entity-engine";
import type { EntityType, EntityInstance } from "@platform/entity-engine";

// ── Test tenant IDs — UUIDs that will never collide with real data ────────────

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000002";

// ── Shared state seeded in beforeAll ─────────────────────────────────────────

let entityType: EntityType;
let tenantBType: EntityType; // tenant-scoped type owned by Tenant B
let instanceA: EntityInstance;
let instanceB: EntityInstance;
let instanceA2: EntityInstance; // second A instance for list/relation tests

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // System entity type (tenant_id = null) — shared across all tenants.
  // entity_types has no RLS so this can use the global db directly.
  entityType = await createEntityType(db, null, {
    name: `isolation_ticket_${Date.now()}`,
    plural: "isolation_tickets",
    allowCustomFields: true,
  });

  // Tenant-scoped entity type owned exclusively by Tenant B.
  tenantBType = await createEntityType(db, TENANT_B, {
    name: `isolation_b_type_${Date.now()}`,
    plural: "isolation_b_types",
    allowCustomFields: true,
  });

  // Seed Tenant A instances
  instanceA = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId: entityType.id,
      fields: {},
    }),
  );

  instanceA2 = await withTenantContext(TENANT_A, (tx) =>
    createEntity(tx, TENANT_A, {
      entityTypeId: entityType.id,
      fields: {},
    }),
  );

  // Seed Tenant B instance
  instanceB = await withTenantContext(TENANT_B, (tx) =>
    createEntity(tx, TENANT_B, {
      entityTypeId: entityType.id,
      fields: {},
    }),
  );
});

afterAll(async () => {
  // Clean up in FK dependency order.
  // The platform user is the DB owner and bypasses RLS for cleanup.
  await db
    .delete(entityRelations)
    .where(eq(entityRelations.tenantId, TENANT_A));
  await db
    .delete(entityRelations)
    .where(eq(entityRelations.tenantId, TENANT_B));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityType.id));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, tenantBType.id));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityType.id));
  await db.delete(entityTypes).where(eq(entityTypes.id, tenantBType.id));
});

// ── GET isolation ─────────────────────────────────────────────────────────────

describe("getEntity — cross-tenant read isolation", () => {
  it("returns EntityError (not Tenant B data) when Tenant A reads Tenant B instance ID", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await expect(
        getEntity(tx, TENANT_A, instanceB.id),
      ).rejects.toBeInstanceOf(EntityError);
    });
  });

  it("Tenant A can read its own instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await getEntity(tx, TENANT_A, instanceA.id);
      expect(result.id).toBe(instanceA.id);
      expect(result.tenantId).toBe(TENANT_A);
    });
  });

  it("returns 404-equivalent error, not a 403 (existence must not be leaked)", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const err = await getEntity(tx, TENANT_A, instanceB.id).catch((e) => e);
      expect(err).toBeInstanceOf(EntityError);
      // ENTITY_NOT_FOUND — same error as a genuinely missing resource
      expect((err as EntityError).code).toBe("ENTITY_NOT_FOUND");
    });
  });
});

// ── UPDATE isolation ──────────────────────────────────────────────────────────

describe("updateEntity — cross-tenant write isolation", () => {
  it("throws EntityError when Tenant A updates Tenant B instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await expect(
        updateEntity(tx, TENANT_A, instanceB.id, {
          fields: { note: "hacked" },
        }),
      ).rejects.toBeInstanceOf(EntityError);
    });
  });

  it("Tenant A can update its own instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await updateEntity(tx, TENANT_A, instanceA.id, {
        fields: {},
      });
      expect(result.id).toBe(instanceA.id);
    });
  });
});

// ── DELETE isolation ──────────────────────────────────────────────────────────

// deleteEntity uses UPDATE...RETURNING with tenantId in the WHERE clause.
// A cross-tenant instanceId matches no rows → empty RETURNING → EntityError.
describe("deleteEntity — cross-tenant delete isolation", () => {
  it("throws EntityError when Tenant A soft-deletes Tenant B instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await expect(
        deleteEntity(tx, TENANT_A, instanceB.id),
      ).rejects.toBeInstanceOf(EntityError);
    });
  });

  it("Tenant B instance is not deleted after Tenant A's failed attempt", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const result = await getEntity(tx, TENANT_B, instanceB.id);
      expect(result.deletedAt).toBeNull();
    });
  });
});

// ── LIST isolation ────────────────────────────────────────────────────────────

describe("listEntities — cross-tenant list isolation", () => {
  it("Tenant A list returns zero Tenant B instances", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const page = await listEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
      });
      const tenantBRows = page.data.filter((i) => i.tenantId === TENANT_B);
      expect(tenantBRows).toHaveLength(0);
    });
  });

  it("Tenant A list contains only Tenant A instances", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const page = await listEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
      });
      expect(page.data.length).toBeGreaterThan(0);
      expect(page.data.every((i) => i.tenantId === TENANT_A)).toBe(true);
    });
  });

  it("Tenant B list does not include Tenant A instances", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const page = await listEntities(tx, TENANT_B, {
        entityTypeId: entityType.id,
      });
      const tenantARows = page.data.filter((i) => i.tenantId === TENANT_A);
      expect(tenantARows).toHaveLength(0);
    });
  });
});

// ── ACCESS-LIST SCOPING (ui-feature-checklist-and-rules.md §1) ────────────────
// Real-Postgres proof of the three-tier records-visibility rule's third tier:
// a plain (non-privileged) caller sees a ticket via scopeToUserId if they
// created it, are assigned to it, OR hold ANY __accessUsers entry — including
// a bare "read_only" grant. This is a jsonb `?` key-existence check
// (packages/entity-engine/src/engine.ts), not a value comparison, so it can
// only be proven against a real Postgres jsonb column — a mocked unit test
// (engine.test.ts) can assert the SQL builder was *called*, but not that the
// operator actually behaves this way. Guards against silently narrowing this
// to read_write/read_comment only, which the checklist flags as an easy
// accidental regression.

describe("listEntities — access-list scoping honors any __accessUsers level (§1)", () => {
  const READ_ONLY_VIEWER = "isolation-read-only-viewer";
  let scopedInstance: EntityInstance;

  beforeAll(async () => {
    scopedInstance = await withTenantContext(TENANT_A, (tx) =>
      createEntity(tx, TENANT_A, {
        entityTypeId: entityType.id,
        fields: {},
      }),
    );
    // Mirrors grant-access.ts's raw jsonb write — a read_only grant is
    // deliberately the weakest access level, to prove even it is sufficient
    // for list visibility.
    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(entityInstances)
        .set({
          fields: {
            __accessUsers: { [READ_ONLY_VIEWER]: { level: "read_only" } },
          },
        })
        .where(eq(entityInstances.id, scopedInstance.id)),
    );
  });

  afterAll(async () => {
    await withTenantContext(TENANT_A, (tx) =>
      tx
        .delete(entityInstances)
        .where(eq(entityInstances.id, scopedInstance.id)),
    );
  });

  it("a read_only __accessUsers grant is sufficient to appear in scopeToUserId results", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const page = await listEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
        scopeToUserId: READ_ONLY_VIEWER,
      });
      expect(page.data.some((i) => i.id === scopedInstance.id)).toBe(true);
    });
  });

  it("a caller with no createdBy/assignedTo/__accessUsers relationship does not see the ticket", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const page = await listEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
        scopeToUserId: "isolation-unrelated-user",
      });
      expect(page.data.some((i) => i.id === scopedInstance.id)).toBe(false);
    });
  });
});

// ── RELATIONS isolation ───────────────────────────────────────────────────────

describe("createRelation — cross-tenant relation isolation", () => {
  it("throws RELATION_TARGET_NOT_FOUND when Tenant A links to Tenant B instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const err = await createRelation(tx, TENANT_A, {
        fromInstanceId: instanceA.id,
        toInstanceId: instanceB.id,
        relationType: "isolation_test",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(EntityError);
      expect((err as EntityError).code).toBe("RELATION_TARGET_NOT_FOUND");
    });
  });

  it("throws RELATION_TARGET_NOT_FOUND when from-instance belongs to Tenant B", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await expect(
        createRelation(tx, TENANT_A, {
          fromInstanceId: instanceB.id,
          toInstanceId: instanceA.id,
          relationType: "isolation_test",
        }),
      ).rejects.toBeInstanceOf(EntityError);
    });
  });

  it("Tenant A can create a relation between its own instances", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rel = await createRelation(tx, TENANT_A, {
        fromInstanceId: instanceA.id,
        toInstanceId: instanceA2.id,
        relationType: "sibling",
      });
      expect(rel.tenantId).toBe(TENANT_A);
    });
  });
});

describe("listRelations — cross-tenant list isolation", () => {
  it("Tenant A cannot list Tenant B relations by passing Tenant B instance ID", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const page = await listRelations(tx, TENANT_A, instanceB.id);
      // Tenant A's tenant_id filter means no Tenant B relations are returned
      expect(page.data.every((r) => r.tenantId === TENANT_A)).toBe(true);
    });
  });
});

// ── SEARCH isolation ──────────────────────────────────────────────────────────

describe("searchEntities — cross-tenant search isolation", () => {
  const UNIQUE_TERM = `isoltest_${Date.now()}`;

  beforeAll(async () => {
    // Insert instances with distinct search content directly so the trigger
    // populates search_vector without going through field validation.
    await db.insert(entityInstances).values([
      {
        entityTypeId: entityType.id,
        tenantId: TENANT_A,
        currentState: "initial",
        fields: { note: UNIQUE_TERM },
      },
      {
        entityTypeId: entityType.id,
        tenantId: TENANT_B,
        currentState: "initial",
        fields: { note: UNIQUE_TERM }, // same term, different tenant
      },
    ]);
  });

  it("search results for Tenant A contain no Tenant B instances", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const page = await searchEntities(tx, TENANT_A, {
        entityTypeId: entityType.id,
        query: UNIQUE_TERM,
      });
      const crossTenant = page.data.filter((i) => i.tenantId !== TENANT_A);
      expect(crossTenant).toHaveLength(0);
    });
  });

  it("search results for Tenant B contain no Tenant A instances", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const page = await searchEntities(tx, TENANT_B, {
        entityTypeId: entityType.id,
        query: UNIQUE_TERM,
      });
      const crossTenant = page.data.filter((i) => i.tenantId !== TENANT_B);
      expect(crossTenant).toHaveLength(0);
    });
  });
});

// ── RLS layer verification ────────────────────────────────────────────────────

describe("RLS — direct query isolation within tenant context", () => {
  // withTenantContext now issues SET LOCAL ROLE app_user before setting the
  // tenant GUC (#121), so RLS policies apply even though CI connects as the
  // `platform` superuser — `SET LOCAL ROLE` inside the transaction switches
  // to a non-superuser, non-BYPASSRLS role for the duration of the query.
  it("direct SELECT within Tenant A context returns no Tenant B rows", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: entityInstances.id, tenantId: entityInstances.tenantId })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.entityTypeId, entityType.id),
            eq(entityInstances.tenantId, TENANT_B),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("direct SELECT for own tenant data succeeds within context", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: entityInstances.id })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.entityTypeId, entityType.id),
            eq(entityInstances.tenantId, TENANT_A),
          ),
        );
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});

// ── ENTITY TYPE isolation ─────────────────────────────────────────────────────

describe("getEntityType — tenant-scoped type isolation", () => {
  it("Tenant A cannot read a type scoped to Tenant B", async () => {
    const err = await getEntityType(db, TENANT_A, tenantBType.id).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(EntityError);
    expect((err as EntityError).code).toBe("ENTITY_TYPE_NOT_FOUND");
  });

  it("Tenant B can read its own scoped type", async () => {
    const result = await getEntityType(db, TENANT_B, tenantBType.id);
    expect(result.id).toBe(tenantBType.id);
    expect(result.tenantId).toBe(TENANT_B);
  });

  it("both tenants can read system types (tenantId=null)", async () => {
    const [resultA, resultB] = await Promise.all([
      getEntityType(db, TENANT_A, entityType.id),
      getEntityType(db, TENANT_B, entityType.id),
    ]);
    expect(resultA.id).toBe(entityType.id);
    expect(resultB.id).toBe(entityType.id);
  });
});

// ── SET STATE isolation ───────────────────────────────────────────────────────

describe("setEntityState — cross-tenant state isolation", () => {
  it("throws EntityError when Tenant A sets state on Tenant B instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await expect(
        setEntityState(tx, TENANT_A, instanceB.id, "hacked"),
      ).rejects.toBeInstanceOf(EntityError);
    });
  });

  it("Tenant B instance state is unchanged after Tenant A's failed attempt", async () => {
    const stateBefore = instanceB.currentState;
    await withTenantContext(TENANT_A, async (tx) => {
      await setEntityState(tx, TENANT_A, instanceB.id, "hacked").catch(
        () => undefined,
      );
    });
    await withTenantContext(TENANT_B, async (tx) => {
      const result = await getEntity(tx, TENANT_B, instanceB.id);
      expect(result.currentState).toBe(stateBefore);
    });
  });

  it("Tenant A can set state on its own instance", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await setEntityState(tx, TENANT_A, instanceA.id, "open");
      expect(result.id).toBe(instanceA.id);
    });
  });
});

// ── BULK operations isolation ─────────────────────────────────────────────────

describe("bulkUpdateEntities — cross-tenant write isolation", () => {
  it("returns ENTITY_NOT_FOUND error for Tenant B instances, does not update them", async () => {
    const result = await bulkUpdateEntities(db, TENANT_A, [
      { id: instanceB.id, input: { fields: { hacked: true } } },
    ]);
    expect(result.updated).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("ENTITY_NOT_FOUND");
    expect(result.errors[0]?.id).toBe(instanceB.id);
  });

  it("valid Tenant A items succeed even when Tenant B IDs are included", async () => {
    const result = await bulkUpdateEntities(db, TENANT_A, [
      { id: instanceB.id, input: { fields: {} } },
      { id: instanceA.id, input: { fields: {} } },
    ]);
    expect(result.updated.map((i) => i.id)).toContain(instanceA.id);
    expect(result.updated.map((i) => i.id)).not.toContain(instanceB.id);
    expect(result.errors[0]?.id).toBe(instanceB.id);
  });
});

describe("bulkSetState — cross-tenant state isolation", () => {
  it("returns ENTITY_NOT_FOUND for Tenant B instances without changing their state", async () => {
    const stateBefore = instanceB.currentState;

    const result = await bulkSetState(db, TENANT_A, [
      { id: instanceB.id, state: "hacked" },
    ]);

    expect(result.updatedIds).not.toContain(instanceB.id);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("ENTITY_NOT_FOUND");

    // Verify Tenant B's instance state is truly unchanged
    await withTenantContext(TENANT_B, async (tx) => {
      const check = await getEntity(tx, TENANT_B, instanceB.id);
      expect(check.currentState).toBe(stateBefore);
    });
  });

  it("processes Tenant A instances while rejecting Tenant B instances in the same batch", async () => {
    const result = await bulkSetState(db, TENANT_A, [
      { id: instanceB.id, state: "hacked" },
      { id: instanceA2.id, state: "closed" },
    ]);

    expect(result.updatedIds).toContain(instanceA2.id);
    expect(result.updatedIds).not.toContain(instanceB.id);
    expect(result.errors[0]?.id).toBe(instanceB.id);
  });
});
