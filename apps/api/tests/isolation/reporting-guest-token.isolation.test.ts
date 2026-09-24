/**
 * Isolation tests for GET /superset/guest-token (embedded reporting).
 *
 * The pass this route mints is what Superset filters every dashboard query
 * by, so the tenant and own-rows boundaries live in the row filters it
 * attaches. These tests run the real handler — auth context, role gate, rule
 * building — and inspect the filters actually handed to Superset. Only the
 * Superset HTTP call is replaced, because it needs a running Superset and has
 * no bearing on which filters are built.
 *
 * The database is the other layer: the reporting role is RLS-bound and the
 * connection is stamped with the pass's tenant, so a wrong filter yields no
 * rows rather than another tenant's. That layer is covered by
 * reporting-grants.isolation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as SupersetClient from "../../src/routes/reporting/superset-client.js";

type Rule = { clause: string; datasetTable?: string };
const minted: { slug: string; tenantId: string; rls: Rule[] }[] = [];

vi.mock(
  "../../src/routes/reporting/superset-client.js",
  async (importOriginal) => {
    const actual = await importOriginal<typeof SupersetClient>();
    return {
      ...actual,
      mintDashboardPass: vi.fn(
        (slug: string, tenantId: string, rls: Rule[]) => {
          minted.push({ slug, tenantId, rls });
          return Promise.resolve({
            token: "guest-token",
            embeddedId: "embedded-id",
          });
        },
      ),
    };
  },
);

const { guestTokenHandler } =
  await import("../../src/routes/reporting/guest-token.js");

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000128";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000129";
const USER_A1 = "user-a1-guest-token-test";
const USER_A2 = "user-a2-guest-token-test";

function makeApp(tenantId: string, userId: string, role: string) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId,
        roles: [role],
        email: "t@example.com",
      });
      await next();
    },
  );
  app.get("/guest-token", ...guestTokenHandler);
  return app;
}

async function mint(
  app: ReturnType<typeof makeApp>,
  dashboard: "tenant" | "user",
): Promise<{ status: number; rls: Rule[] | undefined }> {
  const before = minted.length;
  const res = await app.request(`/guest-token?dashboard=${dashboard}`);
  return { status: res.status, rls: minted[before]?.rls };
}

beforeEach(() => {
  minted.length = 0;
});

describe("GET /superset/guest-token — cross-tenant isolation", () => {
  it("scopes Tenant A's pass to Tenant A and never names Tenant B", async () => {
    const { status, rls } = await mint(
      makeApp(TENANT_A, USER_A1, "admin"),
      "tenant",
    );
    expect(status).toBe(200);
    const clauses = (rls ?? []).map((r) => r.clause).join(" ");
    expect(clauses).toContain(`tenant_id = '${TENANT_A}'`);
    expect(clauses).not.toContain(TENANT_B);
  });

  it("scopes Tenant B's pass to Tenant B, from the same code path", async () => {
    const { status, rls } = await mint(
      makeApp(TENANT_B, USER_A1, "admin"),
      "tenant",
    );
    expect(status).toBe(200);
    const clauses = (rls ?? []).map((r) => r.clause).join(" ");
    expect(clauses).toContain(`tenant_id = '${TENANT_B}'`);
    expect(clauses).not.toContain(TENANT_A);
  });

  it("applies the tenant clause to every dataset, not just some", async () => {
    // An unscoped rule (no datasetTable) is how Superset applies a filter to
    // every dataset on the dashboard; a tenant rule scoped to one dataset
    // would leave the others unfiltered.
    const { rls } = await mint(makeApp(TENANT_A, USER_A1, "agent"), "tenant");
    const tenantRules = (rls ?? []).filter((r) =>
      r.clause.startsWith("tenant_id"),
    );
    expect(tenantRules).toHaveLength(1);
    expect(tenantRules[0]?.datasetTable).toBeUndefined();
  });
});

describe("GET /superset/guest-token — own rows for non-staff", () => {
  it("refuses a customer the tenant-wide dashboard", async () => {
    const { status, rls } = await mint(
      makeApp(TENANT_A, USER_A1, "user"),
      "tenant",
    );
    expect(status).toBe(403);
    expect(rls).toBeUndefined();
  });

  it("narrows a customer's personal dashboard to their own tickets", async () => {
    const { status, rls } = await mint(
      makeApp(TENANT_A, USER_A1, "user"),
      "user",
    );
    expect(status).toBe(200);
    const perDataset = (rls ?? []).filter((r) => r.datasetTable);
    expect(perDataset.length).toBeGreaterThan(0);
    for (const rule of perDataset) {
      expect(rule.clause).toContain(USER_A1);
      expect(rule.clause).not.toContain(USER_A2);
    }
  });
});
