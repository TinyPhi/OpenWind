/**
 * #1190 S1 -- withTenantPurgeRoleSavepoint against a real database: the role is tenant_purge_role
 * inside the callback and is app_user again afterwards, on success and when the callback throws.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { withTenantContext, withTenantPurgeRoleSavepoint } from "@platform/db";

const TENANT = "aaaaaaaa-1190-4000-a000-000000000001";

type Executor = { execute: (q: ReturnType<typeof sql>) => Promise<unknown[]> };

async function currentUser(tx: Executor): Promise<string> {
  const rows = (await tx.execute(sql`SELECT current_user AS u`)) as Array<{
    u: string;
  }>;
  return rows[0]?.u ?? "";
}

describe("withTenantPurgeRoleSavepoint (#1190)", () => {
  it("runs the callback as tenant_purge_role and returns to app_user after it", async () => {
    await withTenantContext(TENANT, async (tx) => {
      expect(await currentUser(tx)).toBe("app_user");

      const inside = await withTenantPurgeRoleSavepoint(tx, (sp) =>
        currentUser(sp),
      );

      expect(inside).toBe("tenant_purge_role");
      expect(await currentUser(tx)).toBe("app_user");
    });
  });

  it("is back to app_user when the callback throws and the caller carries on", async () => {
    await withTenantContext(TENANT, async (tx) => {
      await expect(
        withTenantPurgeRoleSavepoint(tx, async (sp) => {
          expect(await currentUser(sp)).toBe("tenant_purge_role");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await currentUser(tx)).toBe("app_user");
    });
  });

  it("keeps the caller's tenant context inside the savepoint", async () => {
    await withTenantContext(TENANT, async (tx) => {
      const seen = await withTenantPurgeRoleSavepoint(tx, async (sp) => {
        const rows = (await sp.execute(
          sql`SELECT current_setting('app.tenant_id', true) AS t`,
        )) as unknown as Array<{ t: string }>;
        return rows[0]?.t;
      });

      expect(seen).toBe(TENANT);
    });
  });
});
