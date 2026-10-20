import { describe, it, expect, afterAll } from "vitest";
import postgres from "postgres";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)(
  "workflow_events retention index on a real Postgres",
  () => {
    const client = postgres(url as string, { max: 1, prepare: false });
    afterAll(async () => {
      await client.end();
    });

    it("has a (tenant_id, created_at) index for the retention sweep", async () => {
      const rows = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'workflow_events'
        AND indexname = 'workflow_events_tenant_created_at_idx'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.indexdef).toContain("(tenant_id, created_at)");
    });
  },
);
