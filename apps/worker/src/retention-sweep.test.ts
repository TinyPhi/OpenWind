import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const executed: { ctx: string; text: string; params: unknown[] }[] = [];
const dialect = new PgDialect();

const makeRunner = (ctx: string) =>
  vi.fn(
    async (
      _tenantId: string,
      fn: (tx: { execute: (q: SQL) => Promise<unknown[]> }) => Promise<unknown>,
    ) =>
      fn({
        execute: async (q: SQL) => {
          const { sql: text, params } = dialect.sqlToQuery(q);
          executed.push({ ctx, text, params });
          return [];
        },
      }),
  );

vi.mock("@platform/db", () => ({
  withTenantContext: makeRunner("tenant"),
  withEventLogMaintenanceContext: makeRunner("eventlog"),
}));
vi.mock("@platform/config", () => ({
  env: { RETENTION_BATCH_SIZE: 100, RETENTION_BATCH_PAUSE_MS: 0 },
}));
vi.mock("@platform/telemetry", () => ({
  retentionDeletedRowsTotal: { add: vi.fn() },
}));

const { sweepTenant } = await import("./retention-sweep.js");

const policy = {
  hold: false,
  noiseDays: 90,
  commentDays: 365,
  evidenceDays: 2555,
};
const TENANT = "11111111-1111-4111-8111-111111111111";

describe("sweepTenant extended tables", () => {
  beforeEach(() => {
    executed.length = 0;
  });

  it("deletes recipients before notifications, each filtered by tenant", async () => {
    await sweepTenant(TENANT, policy);
    const deletes = executed
      .map((e) => e.text.match(/^DELETE FROM (\w+)/)?.[1])
      .filter(Boolean);
    expect(deletes).toEqual([
      "workflow_events",
      "workflow_events",
      "workflow_events",
      "outbox_events",
      "tenant_usage_daily",
      "notification_recipients",
      "notifications",
      "connector_delivery_attempts",
      "dead_letter_events",
      "idempotency_keys",
    ]);
  });

  it("scopes every new delete to the tenant and the noise window", async () => {
    await sweepTenant(TENANT, policy);
    const added = executed.filter((e) =>
      /^DELETE FROM (notification|connector|dead_letter|idempotency)/.test(
        e.text,
      ),
    );
    expect(added).toHaveLength(5);
    for (const e of added) {
      expect(e.ctx).toBe("tenant");
      expect(e.text).toMatch(/tenant_id = \$\d+/);
      expect(e.params).toContain(TENANT);
      expect(e.params).toContain(90);
    }
  });

  it("does nothing for a held tenant", async () => {
    const result = await sweepTenant(TENANT, { ...policy, hold: true });
    expect(executed).toHaveLength(0);
    expect(Object.values(result).every((n) => n === 0)).toBe(true);
  });
});
