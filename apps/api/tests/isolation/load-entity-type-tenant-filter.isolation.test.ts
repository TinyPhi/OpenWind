/**
 * Proves #220's fix: `loadEntityType` (packages/entity-engine/src/engine.ts) now applies
 * an explicit tenant filter, the same `or(isNull(tenantId), eq(tenantId, ...))` pattern
 * `loadEntityFields` already had. Before the fix, `loadEntityType` had no filter at all and
 * relied entirely on RLS.
 *
 * These tests call `createEntity`/`addEntityField` directly with the bare `db` export — no
 * `withTenantContext`, so `SET LOCAL ROLE app_user` + the tenant GUC (#121) never run and RLS
 * is not enforced (the underlying connection is the superuser role, which bypasses RLS).
 * That isolates the layer under test: if these assertions hold under bare `db`, it's the
 * explicit filter doing the work, not RLS — mirroring how
 * entity-assigned-depth.isolation.test.ts isolates one layer at a time.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@platform/db";
import { entityInstances, entityTypes, entityFields } from "@platform/db";
import {
  createEntityType,
  createEntity,
  addEntityField,
  EntityError,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000220";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000220";

let tenantBPrivateType: EntityType; // private entity type owned exclusively by Tenant B
let sharedType: EntityType; // global entity type (tenantId = null)

beforeAll(async () => {
  tenantBPrivateType = await createEntityType(db, TENANT_B, {
    name: `isolation_220_private_${Date.now()}`,
    plural: "isolation_220_privates",
    allowCustomFields: true,
  });

  sharedType = await createEntityType(db, null, {
    name: `isolation_220_shared_${Date.now()}`,
    plural: "isolation_220_shareds",
    allowCustomFields: true,
  });
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, sharedType.id));
  await db
    .delete(entityFields)
    .where(eq(entityFields.entityTypeId, tenantBPrivateType.id));
  await db.delete(entityTypes).where(eq(entityTypes.id, tenantBPrivateType.id));
  await db.delete(entityTypes).where(eq(entityTypes.id, sharedType.id));
});

describe("loadEntityType — explicit tenant filter (#220)", () => {
  it("createEntity: Tenant A referencing Tenant B's private entityTypeId via bare db throws ENTITY_TYPE_NOT_FOUND", async () => {
    const err = await createEntity(db, TENANT_A, {
      entityTypeId: tenantBPrivateType.id,
      fields: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EntityError);
    expect((err as EntityError).code).toBe("ENTITY_TYPE_NOT_FOUND");
  });

  it("createEntity: Tenant A referencing a shared (tenantId = null) entityTypeId via bare db still succeeds", async () => {
    const instance = await createEntity(db, TENANT_A, {
      entityTypeId: sharedType.id,
      fields: {},
    });
    expect(instance.entityTypeId).toBe(sharedType.id);
    expect(instance.tenantId).toBe(TENANT_A);
  });

  it("addEntityField: Tenant A referencing Tenant B's private entityTypeId via bare db throws ENTITY_TYPE_NOT_FOUND", async () => {
    const err = await addEntityField(db, TENANT_A, tenantBPrivateType.id, {
      name: "should_not_be_added",
      label: "Should Not Be Added",
      fieldType: "text",
      config: {},
      isRequired: false,
      isIndexed: false,
      isSystem: false,
      sortOrder: 0,
      sensitivity: "public",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EntityError);
    expect((err as EntityError).code).toBe("ENTITY_TYPE_NOT_FOUND");
  });
});
