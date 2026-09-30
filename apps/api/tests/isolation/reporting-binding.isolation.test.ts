/**
 * Reporting sessions are bound to their tenant (and, for own-rows sessions, to
 * their user) by a signature the database verifies (migration 0128), not by the
 * settings alone. A session can change its own settings after connect — ad-hoc
 * SQL in Stage 2 can run set_config() — so each case below changes one setting
 * after a valid binding was stamped and asserts the session then sees nothing.
 *
 * Runs as the real reporting role over its own connection; the subject is
 * grants and RLS, which a mock cannot express.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql as dsql } from "drizzle-orm";
import postgres from "postgres";
import {
  db,
  tenants,
  entityTypes,
  entityInstances,
  workflows,
  workflowEvents,
} from "@platform/db";
import { createHmac } from "node:crypto";

// ─── Binding signature + key (mirrors superset_config.reporting_binding_sig) ──
const TEST_BINDING_SECRET = "reporting-binding-isolation-test-secret-0128";

/** Same canonical string as reporting_bound_tenant(): tenant|scope|user_id. */
function bindingSig(
  tenant: string,
  scope = "tenant",
  userId = "",
  secret = TEST_BINDING_SECRET,
): string {
  return createHmac("sha256", secret)
    .update(`${tenant}|${scope}|${userId}`)
    .digest("hex");
}

/**
 * Install the test key and return a function that restores whatever key was
 * there before (a developer's local database may already hold one).
 */
async function installTestBindingKey(): Promise<() => Promise<void>> {
  const before = await db.execute<{ secret: string }>(
    dsql`SELECT secret FROM reporting_binding_key WHERE id = 1`,
  );
  const previous = before[0]?.secret;
  await setBindingKey(TEST_BINDING_SECRET);
  return async () => {
    if (previous === undefined) {
      await db.execute(dsql`DELETE FROM reporting_binding_key WHERE id = 1`);
    } else {
      await setBindingKey(previous);
    }
  };
}

async function setBindingKey(secret: string): Promise<void> {
  await db.execute(dsql`
    INSERT INTO reporting_binding_key (id, secret, updated_at)
    VALUES (1, ${secret}, now())
    ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`);
}

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000128";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000128";
const OWNER = "binding-iso-owner";
const OTHER = "binding-iso-other";

function analyticsUrl(): string {
  const explicit = process.env["ANALYTICS_DATABASE_URL"];
  if (explicit) return explicit;
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  url.username = "analytics_user";
  url.password = "analytics_user_dev_password";
  return url.toString();
}

let sql: postgres.Sql;
let restoreBindingKey: () => Promise<void>;
let entityTypeId: string;
const workflowIds: string[] = [];

type Settings = Record<string, string>;

/** Stamp settings in one transaction, then count what the session can see. */
async function visible(
  settings: Settings,
  table:
    | "entity_instances"
    | "workflow_events"
    | "reporting_instances" = "entity_instances",
): Promise<{ a: number; b: number }> {
  return sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(settings)) {
      await tx`SELECT set_config(${key}, ${value}, true)`;
    }
    const rows = await tx<{ tenant_id: string; n: number }[]>`
      SELECT tenant_id::text, count(*)::int AS n FROM ${tx(table)} GROUP BY tenant_id`;
    const n = (t: string): number =>
      rows.find((r) => r.tenant_id === t)?.n ?? 0;
    return { a: n(TENANT_A), b: n(TENANT_B) };
  }) as Promise<{ a: number; b: number }>;
}

/** A valid tenant-wide binding for tenant A, as the mutator stamps it. */
function boundToA(): Settings {
  return {
    "app.tenant_id": TENANT_A,
    "app.reporting_binding_sig": bindingSig(TENANT_A),
  };
}

/** A valid own-rows binding for OWNER in tenant A. */
function boundToOwner(): Settings {
  return {
    "app.tenant_id": TENANT_A,
    "app.reporting_scope": "own",
    "app.reporting_user_id": OWNER,
    "app.reporting_binding_sig": bindingSig(TENANT_A, "own", OWNER),
  };
}

beforeAll(async () => {
  sql = postgres(analyticsUrl(), { max: 1, onnotice: () => {} });
  restoreBindingKey = await installTestBindingKey();

  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Binding Iso A",
      slug: `binding-iso-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Binding Iso B",
      slug: `binding-iso-b-${Date.now()}`,
    },
  ]);
  const [et] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `binding_iso_${Date.now()}`,
      plural: `binding_isos_${Date.now()}`,
      allowCustomFields: true,
    })
    .returning();
  if (!et) throw new Error("entity type insert failed");
  entityTypeId = et.id;

  for (const tenantId of [TENANT_A, TENANT_B]) {
    const [wf] = await db
      .insert(workflows)
      .values({
        tenantId,
        entityTypeId,
        name: `Binding Iso ${tenantId.slice(0, 1)}`,
        initialState: "open",
        createdBy: OWNER,
      })
      .returning();
    if (!wf) throw new Error("workflow insert failed");
    workflowIds.push(wf.id);
    const tickets = await db
      .insert(entityInstances)
      .values(
        [OWNER, OTHER].map((who) => ({
          entityTypeId,
          tenantId,
          workflowId: wf.id,
          currentState: "open",
          fields: { title: `binding iso ${who}` },
          createdBy: who,
          assignedTo: who,
        })),
      )
      .returning({
        id: entityInstances.id,
        createdBy: entityInstances.createdBy,
      });
    await db.insert(workflowEvents).values(
      tickets.map((t) => ({
        tenantId,
        instanceId: t.id,
        workflowId: wf.id,
        fromState: null,
        toState: "open",
        triggeredBy: "user",
        actorId: t.createdBy,
        comment: "binding iso event",
      })),
    );
  }
});

afterAll(async () => {
  for (const id of workflowIds) {
    await db.delete(workflowEvents).where(eq(workflowEvents.workflowId, id));
  }
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db.delete(workflows).where(eq(workflows.entityTypeId, entityTypeId));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
  await restoreBindingKey();
  await sql.end({ timeout: 5 });
});

describe("reporting tenant binding (migration 0128)", () => {
  it("a valid binding sees its own tenant and nothing else", async () => {
    expect(await visible(boundToA())).toEqual({ a: 2, b: 0 });
    expect(await visible(boundToA(), "workflow_events")).toEqual({
      a: 2,
      b: 0,
    });
  });

  it("re-pointing app.tenant_id after the binding was stamped sees nothing", async () => {
    const settings = { ...boundToA(), "app.tenant_id": TENANT_B };
    expect(await visible(settings)).toEqual({ a: 0, b: 0 });
    expect(await visible(settings, "workflow_events")).toEqual({ a: 0, b: 0 });
  });

  it("the binding also holds through the reporting_instances view", async () => {
    expect(await visible(boundToA(), "reporting_instances")).toEqual({
      a: 2,
      b: 0,
    });
    const repointed = { ...boundToA(), "app.tenant_id": TENANT_B };
    expect(await visible(repointed, "reporting_instances")).toEqual({
      a: 0,
      b: 0,
    });
  });

  it("widening an own-rows session to tenant scope sees nothing", async () => {
    expect(await visible(boundToOwner())).toEqual({ a: 1, b: 0 });
    const widened = { ...boundToOwner(), "app.reporting_scope": "tenant" };
    expect(await visible(widened)).toEqual({ a: 0, b: 0 });
  });

  it("switching an own-rows session to another user sees nothing", async () => {
    const other = { ...boundToOwner(), "app.reporting_user_id": OTHER };
    expect(await visible(other)).toEqual({ a: 0, b: 0 });
  });

  it("a tenant with no signature, or a garbage one, sees nothing", async () => {
    expect(await visible({ "app.tenant_id": TENANT_A })).toEqual({
      a: 0,
      b: 0,
    });
    expect(
      await visible({ ...boundToA(), "app.reporting_binding_sig": "deadbeef" }),
    ).toEqual({ a: 0, b: 0 });
  });

  it("a signature made with a different key sees nothing", async () => {
    const forged = bindingSig(
      TENANT_A,
      "tenant",
      "",
      "some-other-secret-that-is-long-enough",
    );
    expect(
      await visible({ ...boundToA(), "app.reporting_binding_sig": forged }),
    ).toEqual({ a: 0, b: 0 });
  });

  it("without a key installed, even a well-formed binding sees nothing", async () => {
    await db.execute(dsql`DELETE FROM reporting_binding_key WHERE id = 1`);
    try {
      expect(await visible(boundToA())).toEqual({ a: 0, b: 0 });
    } finally {
      await setBindingKey(TEST_BINDING_SECRET);
    }
  });

  it("the audit writer refuses a session whose binding does not verify", async () => {
    await expect(
      sql.begin(async (tx) => {
        for (const [k, v] of Object.entries({
          ...boundToA(),
          "app.tenant_id": TENANT_B,
        })) {
          await tx`SELECT set_config(${k}, ${v}, true)`;
        }
        await tx`SELECT record_reporting_audit(${TENANT_B}::uuid, 'x', 'reporting.query_executed', '{}'::jsonb)`;
      }),
    ).rejects.toThrow(/no verified session tenant/i);
  });

  it("neither the reporting role nor the app role can read the key", async () => {
    const rows = await db.execute<{ analytics: boolean; app: boolean }>(dsql`
      SELECT has_table_privilege('analytics_user', 'reporting_binding_key', 'SELECT') AS analytics,
             has_table_privilege('app_user', 'reporting_binding_key', 'SELECT') AS app`);
    expect(rows[0]).toEqual({ analytics: false, app: false });
    await expect(sql`SELECT secret FROM reporting_binding_key`).rejects.toThrow(
      /permission denied/i,
    );
  });
});
