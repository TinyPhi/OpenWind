/**
 * Isolation tests for ADR-007: RLS on entity_types, workflows, workflow_states,
 * workflow_transitions (migration 0037). These four tables previously had no
 * database-level tenant isolation at all — enforced solely by application-layer
 * checks in workflow-crud.ts (visibleTo/assertWorkflowOwned).
 *
 * Tests the RLS policies directly (not through API routes) since that's the
 * new layer under test here. Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  withTenantContext,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-0037-4000-a000-000000000037";
const TENANT_B = "bbbbbbbb-0037-4000-b000-000000000037";

let systemEntityTypeId: string;
let entityTypeIdA: string;
let entityTypeIdB: string;
let workflowIdA: string;
let workflowIdB: string;

beforeAll(async () => {
  const ts = Date.now();

  // A NULL-tenant (system/template) entity_type. app_user can never write a
  // NULL-tenant row (the write policy has no NULL clause, by design — see
  // ADR-007) — insert with the plain `db` client, matching how the issue #168
  // isolation tests seed the same shared-template shape.
  const [systemRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `adr007_system_type_${ts}`,
      plural: `adr007_system_types_${ts}`,
      allowCustomFields: false,
    })
    .returning();
  if (!systemRow) throw new Error("system entity type insert failed");
  systemEntityTypeId = systemRow.id;

  const [etA] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(entityTypes)
      .values({
        tenantId: TENANT_A,
        name: `adr007_type_a_${ts}`,
        plural: `adr007_types_a_${ts}`,
        allowCustomFields: false,
      })
      .returning(),
  );
  if (!etA) throw new Error("entity type A insert failed");
  entityTypeIdA = etA.id;

  const [etB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(entityTypes)
      .values({
        tenantId: TENANT_B,
        name: `adr007_type_b_${ts}`,
        plural: `adr007_types_b_${ts}`,
        allowCustomFields: false,
      })
      .returning(),
  );
  if (!etB) throw new Error("entity type B insert failed");
  entityTypeIdB = etB.id;

  const [wfA] = await withTenantContext(TENANT_A, (tx) =>
    tx
      .insert(workflows)
      .values({
        tenantId: TENANT_A,
        entityTypeId: entityTypeIdA,
        name: "ADR-007 Workflow A",
        initialState: "open",
      })
      .returning(),
  );
  if (!wfA) throw new Error("workflow A insert failed");
  workflowIdA = wfA.id;

  const [wfB] = await withTenantContext(TENANT_B, (tx) =>
    tx
      .insert(workflows)
      .values({
        tenantId: TENANT_B,
        entityTypeId: entityTypeIdB,
        name: "ADR-007 Workflow B",
        initialState: "open",
      })
      .returning(),
  );
  if (!wfB) throw new Error("workflow B insert failed");
  workflowIdB = wfB.id;

  await withTenantContext(TENANT_A, (tx) =>
    tx.insert(workflowStates).values({
      tenantId: TENANT_A,
      workflowId: workflowIdA,
      name: "open",
      label: "Open",
      sortOrder: 0,
    }),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.insert(workflowStates).values({
      tenantId: TENANT_B,
      workflowId: workflowIdB,
      name: "open",
      label: "Open",
      sortOrder: 0,
    }),
  );

  await withTenantContext(TENANT_A, (tx) =>
    tx.insert(workflowTransitions).values({
      tenantId: TENANT_A,
      workflowId: workflowIdA,
      fromState: "open",
      toState: "closed",
      label: "Close",
    }),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.insert(workflowTransitions).values({
      tenantId: TENANT_B,
      workflowId: workflowIdB,
      fromState: "open",
      toState: "closed",
      label: "Close",
    }),
  );
});

afterAll(async () => {
  await withTenantContext(TENANT_A, (tx) =>
    tx
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflowIdA)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflowIdB)),
  );
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(workflowStates).where(eq(workflowStates.workflowId, workflowIdA)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(workflowStates).where(eq(workflowStates.workflowId, workflowIdB)),
  );
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(workflows).where(eq(workflows.tenantId, TENANT_A)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(workflows).where(eq(workflows.tenantId, TENANT_B)),
  );
  await withTenantContext(TENANT_A, (tx) =>
    tx.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_A)),
  );
  await withTenantContext(TENANT_B, (tx) =>
    tx.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_B)),
  );
  await db.delete(entityTypes).where(eq(entityTypes.id, systemEntityTypeId));
});

describe("entity_types RLS (ADR-007)", () => {
  it("a tenant can read the NULL-tenant (system/template) row", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(entityTypes)
        .where(eq(entityTypes.id, systemEntityTypeId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("a tenant can read its own row but not another tenant's row", async () => {
    const ownRows = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(entityTypes).where(eq(entityTypes.id, entityTypeIdA)),
    );
    expect(ownRows).toHaveLength(1);

    const crossTenantRows = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(entityTypes).where(eq(entityTypes.id, entityTypeIdB)),
    );
    expect(crossTenantRows).toHaveLength(0);
  });

  it("a tenant cannot write a NULL-tenant row via app_user", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(entityTypes).values({
          tenantId: null,
          name: `adr007_blocked_${Date.now()}`,
          plural: `adr007_blocked_plural_${Date.now()}`,
          allowCustomFields: false,
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot write into another tenant's tenant_id", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx
          .update(entityTypes)
          .set({ name: "hijacked" })
          .where(eq(entityTypes.id, entityTypeIdB)),
      ),
    ).resolves.toBeDefined();

    // RLS silently filters the UPDATE to zero rows rather than erroring —
    // confirm Tenant B's row is genuinely unchanged.
    const [row] = await withTenantContext(TENANT_B, (tx) =>
      tx.select().from(entityTypes).where(eq(entityTypes.id, entityTypeIdB)),
    );
    expect(row?.name).not.toBe("hijacked");
  });
});

describe("workflows RLS (ADR-007)", () => {
  it("a tenant can read its own workflow but not another tenant's", async () => {
    const own = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(workflows).where(eq(workflows.id, workflowIdA)),
    );
    expect(own).toHaveLength(1);

    const cross = await withTenantContext(TENANT_A, (tx) =>
      tx.select().from(workflows).where(eq(workflows.id, workflowIdB)),
    );
    expect(cross).toHaveLength(0);
  });
});

describe("workflow_states / workflow_transitions RLS (ADR-007)", () => {
  it("a tenant can read its own workflow_states but not another tenant's", async () => {
    const own = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(workflowStates)
        .where(eq(workflowStates.workflowId, workflowIdA)),
    );
    expect(own).toHaveLength(1);

    const cross = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(workflowStates)
        .where(eq(workflowStates.workflowId, workflowIdB)),
    );
    expect(cross).toHaveLength(0);
  });

  it("a tenant can read its own workflow_transitions but not another tenant's", async () => {
    const own = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(workflowTransitions)
        .where(eq(workflowTransitions.workflowId, workflowIdA)),
    );
    expect(own).toHaveLength(1);

    const cross = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select()
        .from(workflowTransitions)
        .where(eq(workflowTransitions.workflowId, workflowIdB)),
    );
    expect(cross).toHaveLength(0);
  });

  it("a tenant cannot write a workflow_state under another tenant's tenant_id", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(workflowStates).values({
          tenantId: TENANT_B,
          workflowId: workflowIdB,
          name: "hijacked",
          label: "Hijacked",
          sortOrder: 99,
        }),
      ),
    ).rejects.toThrow();
  });

  it("a tenant cannot write a workflow_transition under another tenant's tenant_id", async () => {
    await expect(
      withTenantContext(TENANT_A, (tx) =>
        tx.insert(workflowTransitions).values({
          tenantId: TENANT_B,
          workflowId: workflowIdB,
          fromState: "open",
          toState: "hijacked",
          label: "Hijacked",
        }),
      ),
    ).rejects.toThrow();
  });
});
