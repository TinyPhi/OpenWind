import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as SupersetClient from "./superset-client.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// The auth context every test starts from. Individual tests mutate `authState`
// rather than re-mocking, so a role change between two requests can be
// simulated the way it actually happens: same middleware, different claims.
const authState: AuthContext = {
  tenantId: "00000000-0000-0000-0000-000000000001",
  userId: "386221876596178947",
  roles: ["agent"],
  email: "agent@example.com",
} as AuthContext;

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", authState);
      await next();
    },
  requireRole:
    (...allowed: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const roles = c.get("auth").roles ?? [];
      if (!roles.some((r) => allowed.includes(r))) {
        // 404, not 403 — the platform's existing-resource oracle convention.
        return c.json({ error: "NOT_FOUND", message: "Not found" }, 404);
      }
      await next();
    },
}));

const mintDashboardPass = vi.fn();

vi.mock("./superset-client.js", async () => {
  const actual = await vi.importActual<typeof SupersetClient>(
    "./superset-client.js",
  );
  return {
    ...actual,
    mintDashboardPass: (...args: unknown[]) => mintDashboardPass(...args),
  };
});

vi.mock("@platform/config", () => ({
  env: {
    SUPERSET_SITE_URL: "http://localhost:8088",
    SUPERSET_INTERNAL_URL: "http://superset:8088",
    SUPERSET_DASHBOARD_TENANT_SLUG: "openwind-tenant-overview",
    SUPERSET_DASHBOARD_USER_SLUG: "openwind-my-performance",
    SUPERSET_SERVICE_ACCOUNT_USER: "service_account",
    SUPERSET_SERVICE_ACCOUNT_PASSWORD: "pw",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// The audit write goes through the real tenant-context wrapper in production;
// here the wrapper just hands the callback a transaction stand-in, so the test
// checks what is written, not how the transaction is opened.
const writeAuditEntry = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => writeAuditEntry(...args),
}));
vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({}),
}));

const { guestTokenHandler } = await import("./guest-token.js");

function buildApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/superset/guest-token", ...guestTokenHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.roles = ["agent"];
  mintDashboardPass.mockResolvedValue({
    token: "guest-token-value",
    embeddedId: "023c70fc-fe94-40cc-a625-e9532cefe4d3",
  });
});

describe("GET /superset/guest-token", () => {
  it("mints a pass for the tenant dashboard", async () => {
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=tenant",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, string> };
    expect(body.data.token).toBe("guest-token-value");
    expect(body.data.dashboardId).toBe("023c70fc-fe94-40cc-a625-e9532cefe4d3");
    expect(body.data.supersetDomain).toBe("http://localhost:8088");
  });

  it("records every pass it mints in the audit store", async () => {
    await buildApp().request("/superset/guest-token?dashboard=tenant");
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(writeAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      tenantId: authState.tenantId,
      actorId: authState.userId,
      action: "reporting.guest_token_issued",
      resourceType: "reporting_dashboard",
      resourceId: "023c70fc-fe94-40cc-a625-e9532cefe4d3",
      metadata: {
        dashboard: "tenant",
        dashboardSlug: "openwind-tenant-overview",
      },
    });
  });

  it("records a refused dashboard as a denial, and mints nothing", async () => {
    authState.roles = ["user"];
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=tenant",
    );
    expect(res.status).toBe(403);
    expect(mintDashboardPass).not.toHaveBeenCalled();
    expect(writeAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      action: "reporting.guest_token_denied",
      metadata: { dashboard: "tenant" },
    });
  });

  it("still returns the pass when the audit write fails", async () => {
    // Best-effort by design: an audit-store hiccup must not break an open
    // dashboard that re-mints every minute.
    writeAuditEntry.mockRejectedValueOnce(new Error("audit store down"));
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=tenant",
    );
    expect(res.status).toBe(200);
  });

  it("rejects an unknown dashboard name", async () => {
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=everything",
    );
    expect(res.status).toBe(400);
    expect(mintDashboardPass).not.toHaveBeenCalled();
  });
});

describe("tenant scoping", () => {
  it("passes the caller's tenant id as the guest identity", async () => {
    // Load-bearing: Superset stamps this onto the database connection as
    // app.tenant_id, which is what makes row-level security apply. If this ever
    // stops being the tenant id, isolation silently becomes filter-only.
    await buildApp().request("/superset/guest-token?dashboard=tenant");
    const [, tenantId] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(tenantId).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("always attaches a tenant row filter", async () => {
    await buildApp().request("/superset/guest-token?dashboard=tenant");
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string }[],
    ];
    expect(rls).toEqual([
      { clause: "tenant_id = '00000000-0000-0000-0000-000000000001'" },
    ]);
  });

  it("adds an assigned-or-created filter on the per-user dashboard", async () => {
    await buildApp().request("/superset/guest-token?dashboard=user");
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string }[],
    ];
    expect(rls.length).toBeGreaterThan(1);
    expect(rls[1]!.clause).toBe(
      "(assigned_to = '386221876596178947' OR created_by = '386221876596178947')",
    );
  });

  it("scopes the per-user filter to every dataset that carries those columns", async () => {
    // The dangerous direction is naming too few. Superset returns a dataset
    // with no rule attached *unfiltered*, so a personal tile built on an
    // unlisted dataset would show the whole tenant — it fails open. This
    // asserts the set, not a count, so adding a dataset without scoping it
    // breaks the test rather than shipping silently.
    await buildApp().request("/superset/guest-token?dashboard=user");
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string; datasetTable?: string }[],
    ];
    const scoped = rls
      .filter((r) => r.datasetTable !== undefined)
      .map((r) => r.datasetTable)
      .sort();
    expect(scoped).toEqual([
      "entity_instances",
      "my_tickets_assigned",
      "my_tickets_created",
      "ticket_list",
    ]);
  });

  it("narrows the raised-by and assigned-to datasets to one column each", async () => {
    // These two exist only to be filtered differently — that is the whole
    // reason they are separate datasets over identical SQL. If either widened
    // to the assigned-or-created predicate, the dashboard would show the same
    // number twice and neither figure would answer its own question.
    await buildApp().request("/superset/guest-token?dashboard=user");
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string; datasetTable?: string }[],
    ];
    const clauseFor = (table: string) =>
      rls.find((r) => r.datasetTable === table)?.clause;

    expect(clauseFor("my_tickets_created")).toBe(
      "created_by = '386221876596178947'",
    );
    expect(clauseFor("my_tickets_assigned")).toBe(
      "assigned_to = '386221876596178947'",
    );
    // The detail table stays deliberately wider — it lists everything the
    // viewer is involved in, which is both of the above.
    expect(clauseFor("ticket_list")).toBe(
      "(assigned_to = '386221876596178947' OR created_by = '386221876596178947')",
    );
  });

  it("never leaves a per-user clause unscoped", async () => {
    // The opposite failure to the one above. Superset applies an unscoped rule
    // to every dataset as raw SQL with no column checking, so a per-user
    // clause that named no dataset would break every event-backed tile with an
    // unknown-column error — these columns exist only on the ticket datasets.
    await buildApp().request("/superset/guest-token?dashboard=user");
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string; datasetTable?: string }[],
    ];
    const unscoped = rls.filter((r) => r.datasetTable === undefined);
    expect(unscoped).toHaveLength(1);
    expect(unscoped[0]!.clause).toContain("tenant_id");
  });

  it("leaves the tenant filter unscoped so it applies to every dataset", async () => {
    // The inverse of the rule above: every reporting table carries tenant_id,
    // and a tenant clause that reached only one dataset would be a hole.
    await buildApp().request("/superset/guest-token?dashboard=user");
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string; datasetTable?: string }[],
    ];
    expect(rls[0]!.clause).toContain("tenant_id");
    expect(rls[0]!.datasetTable).toBeUndefined();
  });

  it("accepts an api-key principal id, which is not a UUID", async () => {
    // `apikey:<uuid>` contains ':' and '-'. An earlier revision validated the
    // principal as a UUID, which made this path fail 100% of the time.
    authState.userId = "apikey:11111111-2222-3333-4444-555555555555";
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=user",
    );
    expect(res.status).toBe(200);
    authState.userId = "386221876596178947";
  });

  it("refuses a principal id carrying a quote", async () => {
    // The filter is raw SQL with no parameterised form, so the allowlist is the
    // only thing standing between a crafted id and the clause.
    authState.userId = "x' OR '1'='1";
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=user",
    );
    expect(res.status).toBe(502);
    expect(mintDashboardPass).not.toHaveBeenCalled();
    authState.userId = "386221876596178947";
  });
});

describe("authorisation", () => {
  it("never reads tenantId or userId from the query string", async () => {
    // The primary defence against minting a pass for someone else's tenant.
    await buildApp().request(
      "/superset/guest-token?dashboard=tenant" +
        "&tenantId=00000000-0000-0000-0000-0000000000ff" +
        "&userId=999999",
    );
    const [, tenantId, rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string }[],
    ];
    expect(tenantId).toBe("00000000-0000-0000-0000-000000000001");
    expect(rls[0]!.clause).toContain("00000000-0000-0000-0000-000000000001");
    expect(rls[0]!.clause).not.toContain("0000000000ff");
  });

  it("refuses a customer the tenant-wide dashboard with 403", async () => {
    // "user" now passes requireRole (customers may reach their own "My
    // Tickets" dashboard) so the tenant-wide tab is refused inside the
    // handler instead — a 403, not requireRole's 404-for-unmatched-role.
    authState.roles = ["user"];
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=tenant",
    );
    expect(res.status).toBe(403);
    expect(mintDashboardPass).not.toHaveBeenCalled();
  });

  it("refuses the next mint after a role downgrade mid-session", async () => {
    const app = buildApp();
    const first = await app.request("/superset/guest-token?dashboard=tenant");
    expect(first.status).toBe(200);

    authState.roles = ["user"];
    const second = await app.request("/superset/guest-token?dashboard=tenant");
    expect(second.status).toBe(403);
  });

  it("lets a customer mint their own dashboard, scoped to their own tickets", async () => {
    authState.roles = ["user"];
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=user",
    );
    expect(res.status).toBe(200);
    const [, , rls] = mintDashboardPass.mock.calls[0] as [
      string,
      string,
      { clause: string }[],
    ];
    // Same clause staff get on their own tab — a customer is never
    // `assigned_to`, so it naturally collapses to their own created tickets.
    expect(rls[1]!.clause).toBe(
      "(assigned_to = '386221876596178947' OR created_by = '386221876596178947')",
    );
  });

  it("refuses an unrecognised role entirely, with requireRole's 404", async () => {
    authState.roles = ["nobody"];
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=user",
    );
    expect(res.status).toBe(404);
    expect(mintDashboardPass).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  it("returns a flat 502 that leaks no internal detail", async () => {
    mintDashboardPass.mockRejectedValue(
      new Error("connect ECONNREFUSED superset:8088 — service_account"),
    );
    const res = await buildApp().request(
      "/superset/guest-token?dashboard=tenant",
    );
    expect(res.status).toBe(502);

    const raw = await res.text();
    expect(raw).toContain("REPORTING_UNAVAILABLE");
    expect(raw).not.toContain("superset:8088");
    expect(raw).not.toContain("service_account");
    expect(raw).not.toContain("ECONNREFUSED");
  });
});
