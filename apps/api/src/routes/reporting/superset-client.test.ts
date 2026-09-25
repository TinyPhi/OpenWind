import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A JWT-shaped pass whose payload expires `ttlSeconds` from now. */
function passExpiringIn(ttlSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

vi.mock("@platform/config", () => ({
  env: {
    SUPERSET_SITE_URL: "http://localhost:8088",
    SUPERSET_INTERNAL_URL: "http://superset:8088",
    SUPERSET_REPORTING_DB_NAME: "OpenWind Platform",
    SUPERSET_SERVICE_ACCOUNT_USER: "service_account",
    SUPERSET_SERVICE_ACCOUNT_PASSWORD: "pw",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { resolveDatasetId, SupersetUnavailableError } =
  await import("./superset-client.js");

// resolveDatasetId only reads `accessToken` off the session; the other fields
// exist for the mint call and are irrelevant here.
const session = {
  accessToken: "token",
  csrfToken: "csrf",
  cookie: "session=x",
} as Parameters<typeof resolveDatasetId>[1];

function respondWith(rows: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: rows }),
    }),
  );
}

const ON_MANAGED = { database_name: "OpenWind Platform" };
const ON_ORPHAN = { database_name: "OpenWind Platform (Postgres)" };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("resolveDatasetId", () => {
  it("resolves a dataset on the managed connection", async () => {
    respondWith([{ id: 3, database: ON_MANAGED }]);
    await expect(resolveDatasetId("entity_instances", session)).resolves.toBe(
      3,
    );
  });

  it("ignores a same-named dataset on another connection", async () => {
    // The live failure this guards: an orphaned connection left a second
    // `entity_instances` behind. Taking result[0] blindly resolved to whichever
    // Superset happened to list first.
    respondWith([
      { id: 1, database: ON_ORPHAN },
      { id: 3, database: ON_MANAGED },
    ]);
    await expect(resolveDatasetId("entity_instances", session)).resolves.toBe(
      3,
    );
  });

  it("refuses rather than guesses when the name is ambiguous", async () => {
    // Failing closed is the point. A mis-resolved id silently detaches the row
    // filter it scopes, so the caller would see more rows and no error at all.
    respondWith([
      { id: 3, database: ON_MANAGED },
      { id: 9, database: ON_MANAGED },
    ]);
    await expect(
      resolveDatasetId("entity_instances", session),
    ).rejects.toBeInstanceOf(SupersetUnavailableError);
  });

  it("treats a dataset only on a foreign connection as missing", async () => {
    respondWith([{ id: 1, database: ON_ORPHAN }]);
    await expect(resolveDatasetId("entity_instances", session)).rejects.toThrow(
      /not registered/,
    );
  });

  it("reports a missing dataset as provisioning, not an outage", async () => {
    respondWith([]);
    await expect(resolveDatasetId("entity_instances", session)).rejects.toThrow(
      /not registered/,
    );
  });
});

describe("mintDashboardPass coverage guard", () => {
  // Reproduces the live failure: the dashboard gained two datasets, the
  // running API still carried filters for only the original two, and both
  // personal counters rendered the tenant's total instead of the viewer's.
  const DASHBOARD_DATASETS = [
    "entity_instances",
    "ticket_list",
    "my_tickets_created",
    "my_tickets_assigned",
  ];

  const GUEST_TOKEN = passExpiringIn(60);

  function stubSuperset(token: string = GUEST_TOKEN): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const ok = (body: unknown) => ({
          ok: true,
          json: () => Promise.resolve(body),
          headers: { get: () => "session=abc" },
        });
        if (url.includes("/security/login")) return ok({ access_token: "t" });
        if (url.includes("/csrf_token")) return ok({ result: "csrf" });
        if (url.includes("/embedded"))
          return ok({ result: { uuid: "embed-uuid" } });
        if (url.includes("/datasets"))
          return ok({
            result: DASHBOARD_DATASETS.map((t) => ({ table_name: t })),
          });
        if (url.includes("/dataset/"))
          return ok({ result: [{ id: 3, database: ON_MANAGED }] });
        if (url.includes("/guest_token")) return ok({ token });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("refuses to mint when a dashboard dataset has no row filter", async () => {
    stubSuperset();
    const { mintDashboardPass } = await import("./superset-client.js");
    await expect(
      mintDashboardPass(
        "openwind-my-performance",
        "00000000-0000-0000-0000-000000000001",
        [
          { clause: "tenant_id = 'x'" },
          { clause: "a", datasetTable: "entity_instances" },
          { clause: "b", datasetTable: "ticket_list" },
        ],
        true,
      ),
    ).rejects.toThrow(/my_tickets_created|my_tickets_assigned/);
  });

  it("mints once every dataset is covered", async () => {
    stubSuperset();
    const { mintDashboardPass } = await import("./superset-client.js");
    const result = await mintDashboardPass(
      "openwind-my-performance",
      "00000000-0000-0000-0000-000000000001",
      [
        { clause: "tenant_id = 'x'" },
        ...DASHBOARD_DATASETS.map((t) => ({ clause: "c", datasetTable: t })),
      ],
      true,
    );
    expect(result.token).toBe(GUEST_TOKEN);
  });

  it("does not require per-dataset coverage on the tenant dashboard", async () => {
    // There the tenant clause is deliberately unscoped and applies everywhere,
    // so there is no per-dataset rule that could be missing.
    stubSuperset();
    const { mintDashboardPass } = await import("./superset-client.js");
    const result = await mintDashboardPass(
      "openwind-tenant-overview",
      "00000000-0000-0000-0000-000000000001",
      [{ clause: "tenant_id = 'x'" }],
    );
    expect(result.token).toBe(GUEST_TOKEN);
  });

  it("refuses a pass that outlives the allowed lifetime", async () => {
    // Superset's 300s default, as if GUEST_TOKEN_JWT_EXP_SECONDS were lost.
    stubSuperset(passExpiringIn(300));
    const { mintDashboardPass } = await import("./superset-client.js");
    await expect(
      mintDashboardPass(
        "openwind-tenant-overview",
        "00000000-0000-0000-0000-000000000001",
        [{ clause: "tenant_id = 'x'" }],
      ),
    ).rejects.toThrow(/outliving the allowed lifetime/);
  });
});

describe("isGuestTokenLifetimeAcceptable", () => {
  it("accepts a pass within the limit and refuses one beyond it", async () => {
    const { isGuestTokenLifetimeAcceptable, MAX_GUEST_TOKEN_LIFETIME_SECONDS } =
      await import("./superset-client.js");
    const now = Date.now();
    expect(isGuestTokenLifetimeAcceptable(passExpiringIn(60), now)).toBe(true);
    expect(
      isGuestTokenLifetimeAcceptable(
        passExpiringIn(MAX_GUEST_TOKEN_LIFETIME_SECONDS + 60),
        now,
      ),
    ).toBe(false);
  });

  it("refuses a pass with no readable expiry", async () => {
    const { isGuestTokenLifetimeAcceptable } =
      await import("./superset-client.js");
    const noExp = `h.${Buffer.from("{}").toString("base64url")}.s`;
    expect(isGuestTokenLifetimeAcceptable(noExp, Date.now())).toBe(false);
    expect(isGuestTokenLifetimeAcceptable("not-a-jwt", Date.now())).toBe(false);
  });
});
