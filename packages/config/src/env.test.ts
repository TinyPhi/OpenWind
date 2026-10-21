import { describe, it, expect } from "vitest";
import { EnvSchema } from "./env.js";
import { DEV_SUPERSET_DEFAULTS, DEV_METRICS_TOKEN } from "./dev-defaults.js";

// Mirrors vitest.config.ts's fixture, minus RATE_LIMIT_TENANT_PER_MIN — the
// field under test — so each test controls it explicitly or omits it.
const MINIMAL_VALID_ENV = {
  NODE_ENV: "test",
  DATABASE_URL:
    "postgresql://platform:platform_test_password@localhost:5432/platform_test",
  REDIS_URL: "redis://localhost:6379",
  ZITADEL_ISSUER: "http://localhost:8080",
  ZITADEL_AUDIENCE: "platform-api",
  ZITADEL_INTROSPECTION_URL: "http://localhost:8080/oauth/v2/introspect",
  ZITADEL_INTROSPECTION_CLIENT_ID: "test-client-id",
  ZITADEL_INTROSPECTION_CLIENT_SECRET: "test-client-secret",
  NOVU_API_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  OPENBAO_ADDR: "http://localhost:8200",
  OPENBAO_TOKEN: "dev-root-token",
};

describe("SUPERSET_REDIS_URL (#728)", () => {
  it("is optional, so the cache flush is off unless configured", () => {
    expect(
      EnvSchema.parse(MINIMAL_VALID_ENV).SUPERSET_REDIS_URL,
    ).toBeUndefined();
  });

  it("accepts a url and rejects anything else", () => {
    const ok = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      SUPERSET_REDIS_URL: "redis://redis:6379/2",
    });
    expect(ok.SUPERSET_REDIS_URL).toBe("redis://redis:6379/2");
    expect(
      EnvSchema.safeParse({ ...MINIMAL_VALID_ENV, SUPERSET_REDIS_URL: "nope" })
        .success,
    ).toBe(false);
  });
});

describe("REDIS_CACHE_URL (#1013)", () => {
  it("is optional, so one Redis still works for dev", () => {
    expect(EnvSchema.parse(MINIMAL_VALID_ENV).REDIS_CACHE_URL).toBeUndefined();
  });

  it("accepts a url and rejects anything else", () => {
    const ok = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      REDIS_CACHE_URL: "redis://redis-cache:6379",
    });
    expect(ok.REDIS_CACHE_URL).toBe("redis://redis-cache:6379");
    expect(
      EnvSchema.safeParse({ ...MINIMAL_VALID_ENV, REDIS_CACHE_URL: "nope" })
        .success,
    ).toBe(false);
  });
});

describe("retention bounds and the shorten confirmation (#637)", () => {
  it("default to the sweep's long-standing ranges and to requiring confirmation", () => {
    const p = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect([p.RETENTION_DAYS_MIN, p.RETENTION_DAYS_MAX]).toEqual([7, 3650]);
    expect([
      p.RETENTION_COMMENT_DAYS_MIN,
      p.RETENTION_COMMENT_DAYS_MAX,
    ]).toEqual([30, 3650]);
    expect([
      p.RETENTION_EVIDENCE_DAYS_MIN,
      p.RETENTION_EVIDENCE_DAYS_MAX,
    ]).toEqual([365, 7300]);
    expect(p.RETENTION_REQUIRE_SHORTEN_CONFIRM).toBe(true);
  });

  it("accept a changed range that still contains the default", () => {
    const p = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      RETENTION_DAYS_MIN: "30",
      RETENTION_DAYS_MAX: "1000",
    });
    expect([p.RETENTION_DAYS_MIN, p.RETENTION_DAYS_MAX]).toEqual([30, 1000]);
  });

  it.each([
    [
      "a minimum above its maximum",
      { RETENTION_DAYS_MIN: "500", RETENTION_DAYS_MAX: "100" },
    ],
    ["a default below the range", { RETENTION_DAYS_MIN: "100" }],
    ["a default above the range", { RETENTION_DAYS_MAX: "60" }],
    [
      "a comment default outside its range",
      { RETENTION_COMMENT_DAYS_MIN: "400" },
    ],
    [
      "an evidence default outside its range",
      { RETENTION_EVIDENCE_DAYS_MAX: "2000" },
    ],
    ["a bound below 1 day", { RETENTION_DAYS_MIN: "0" }],
    ["a bound above 100 years", { RETENTION_DAYS_MAX: "36501" }],
  ])("reject %s", (_label, extra) => {
    expect(() => EnvSchema.parse({ ...MINIMAL_VALID_ENV, ...extra })).toThrow();
  });

  it("turns the confirmation off only for the literal false", () => {
    const off = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      RETENTION_REQUIRE_SHORTEN_CONFIRM: "false",
    });
    expect(off.RETENTION_REQUIRE_SHORTEN_CONFIRM).toBe(false);
    for (const v of ["true", "flase", "0", ""]) {
      expect(
        EnvSchema.parse({
          ...MINIMAL_VALID_ENV,
          RETENTION_REQUIRE_SHORTEN_CONFIRM: v,
        }).RETENTION_REQUIRE_SHORTEN_CONFIRM,
      ).toBe(true);
    }
  });
});

describe("RATE_LIMIT_TENANT_PER_MIN", () => {
  it("defaults to 600 when absent from the environment", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.RATE_LIMIT_TENANT_PER_MIN).toBe(600);
  });

  it("still honors an explicit override", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      RATE_LIMIT_TENANT_PER_MIN: "1200",
    });
    expect(parsed.RATE_LIMIT_TENANT_PER_MIN).toBe(1200);
  });
});

describe("API_BODY_LIMIT_BYTES (#1012)", () => {
  it("defaults to 2 MiB and honors an override", () => {
    expect(EnvSchema.parse(MINIMAL_VALID_ENV).API_BODY_LIMIT_BYTES).toBe(
      2 * 1024 * 1024,
    );
    expect(
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, API_BODY_LIMIT_BYTES: "4096" })
        .API_BODY_LIMIT_BYTES,
    ).toBe(4096);
  });

  it("refuses a limit too small to carry a request", () => {
    expect(() =>
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, API_BODY_LIMIT_BYTES: "10" }),
    ).toThrow();
  });
});

describe("platform_admin step-up MFA settings (ADR-022, #865, #801)", () => {
  it("default to a 5-minute freshness window and a 30-second resend cooldown", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS).toBe(300);
    expect(parsed.PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS).toBe(30);
  });

  it("accept explicit values from the environment as strings", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS: "600",
      PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS: "60",
    });
    expect(parsed.PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS).toBe(600);
    expect(parsed.PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS).toBe(60);
  });

  it.each([
    ["PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS", "59"],
    ["PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS", "901"],
    ["PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS", "0"],
    ["PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS", "2.5"],
    ["PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS", "4"],
    ["PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS", "301"],
  ])(
    "reject %s=%s, so the step-up cannot be switched off or stretched into the long window",
    (key, value) => {
      expect(() =>
        EnvSchema.parse({ ...MINIMAL_VALID_ENV, [key]: value }),
      ).toThrow();
    },
  );
});

describe("PLATFORM_ADMIN_MFA_DEV_BYPASS", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["0", false],
    ["no", false],
    ["TRUE", false],
    ["true", true],
  ])(
    "%s -> %s (only the literal 'true' turns the bypass on)",
    (value, expected) => {
      const parsed = EnvSchema.parse(
        value === undefined
          ? MINIMAL_VALID_ENV
          : { ...MINIMAL_VALID_ENV, PLATFORM_ADMIN_MFA_DEV_BYPASS: value },
      );
      expect(parsed.PLATFORM_ADMIN_MFA_DEV_BYPASS).toBe(expected);
    },
  );

  it("is still refused in production", () => {
    expect(() =>
      EnvSchema.parse({
        ...MINIMAL_VALID_ENV,
        NODE_ENV: "production",
        PLATFORM_ADMIN_MFA_DEV_BYPASS: "true",
      }),
    ).toThrow(/PLATFORM_ADMIN_MFA_DEV_BYPASS must not be true in production/);
  });
});

describe("OPS_ALERT_EMAIL", () => {
  it.each([undefined, "", "ops@example.com", "a@example.com, b@example.com"])(
    "accepts %s",
    (value) => {
      expect(() =>
        EnvSchema.parse(
          value === undefined
            ? MINIMAL_VALID_ENV
            : { ...MINIMAL_VALID_ENV, OPS_ALERT_EMAIL: value },
        ),
      ).not.toThrow();
    },
  );

  it.each(["not-an-email", "ops@example.com, nope"])("rejects %s", (value) => {
    expect(() =>
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, OPS_ALERT_EMAIL: value }),
    ).toThrow(/OPS_ALERT_EMAIL/);
  });
});

describe("MANDATORY_FIELDS_MODE", () => {
  it("defaults to log", () => {
    expect(EnvSchema.parse(MINIMAL_VALID_ENV).MANDATORY_FIELDS_MODE).toBe(
      "log",
    );
  });

  it("accepts enforce and rejects anything else", () => {
    expect(
      EnvSchema.parse({
        ...MINIMAL_VALID_ENV,
        MANDATORY_FIELDS_MODE: "enforce",
      }).MANDATORY_FIELDS_MODE,
    ).toBe("enforce");
    expect(() =>
      EnvSchema.parse({
        ...MINIMAL_VALID_ENV,
        MANDATORY_FIELDS_MODE: "strict",
      }),
    ).toThrow();
  });
});

describe("SECRETS_PROVIDER", () => {
  it("defaults to openbao and requires OPENBAO_ADDR", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.SECRETS_PROVIDER).toBe("openbao");

    const invalidEnv = { ...MINIMAL_VALID_ENV };
    delete (invalidEnv as Record<string, unknown>).OPENBAO_ADDR;
    expect(() => EnvSchema.parse(invalidEnv)).toThrow();
  });

  it("allows setting SECRETS_PROVIDER to local, bypassing OpenBao checks", () => {
    const localEnv = {
      ...MINIMAL_VALID_ENV,
      SECRETS_PROVIDER: "local",
    };
    delete (localEnv as Record<string, unknown>).OPENBAO_ADDR;
    delete (localEnv as Record<string, unknown>).OPENBAO_TOKEN;

    const parsed = EnvSchema.parse(localEnv);
    expect(parsed.SECRETS_PROVIDER).toBe("local");
  });
});

describe("TELEMETRY", () => {
  it("defaults TELEMETRY_ENABLED to false when absent", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.TELEMETRY_ENABLED).toBe(false);
  });

  it("coerces TELEMETRY_ENABLED string 'true' to boolean true", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      TELEMETRY_ENABLED: "true",
    });
    expect(parsed.TELEMETRY_ENABLED).toBe(true);
  });
});

describe("ERROR_TRACKING", () => {
  it("defaults ERROR_TRACKING_PROVIDER to 'none' when absent", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.ERROR_TRACKING_PROVIDER).toBe("none");
    expect(parsed.SENTRY_DSN).toBeUndefined();
  });

  it("fails validation when provider is sentry but SENTRY_DSN is absent", () => {
    const invalidEnv = {
      ...MINIMAL_VALID_ENV,
      ERROR_TRACKING_PROVIDER: "sentry",
    };
    expect(() => EnvSchema.parse(invalidEnv)).toThrow();
  });

  it("succeeds validation when provider is sentry and SENTRY_DSN is present", () => {
    const validEnv = {
      ...MINIMAL_VALID_ENV,
      ERROR_TRACKING_PROVIDER: "sentry",
      SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
    };
    const parsed = EnvSchema.parse(validEnv);
    expect(parsed.ERROR_TRACKING_PROVIDER).toBe("sentry");
    expect(parsed.SENTRY_DSN).toBe(
      "https://examplePublicKey@o0.ingest.sentry.io/0",
    );
  });
});

// ─── Reporting (3G) — Superset secret guards ────────────────────────────────
//
// These are the first production-default guards in this suite. The reporting
// spec's §S threat model claims "forge a pass offline using a default signing
// secret" is blocked by exactly these refines, so a regression here silently
// turns a documented mitigation into a false claim.
//
// Every case below starts from a production env that is otherwise completely
// valid, and changes one value. Without that, a test could pass because some
// unrelated production rule threw — proving nothing about the guard under test.
const { OPENBAO_TOKEN: _devToken, ...MINIMAL_WITHOUT_TOKEN } =
  MINIMAL_VALID_ENV;
const PRODUCTION_ENV = {
  ...MINIMAL_WITHOUT_TOKEN,
  NODE_ENV: "production",
  // Production OpenBao: AppRole over https, never a static token (ADR-023).
  OPENBAO_ADDR: "https://openbao.example.com:8200",
  OPENBAO_ROLE_ID: "role-id",
  OPENBAO_SECRET_ID: "secret-id",
  METRICS_TOKEN: "a-real-metrics-token",
  // Required in production by an existing refine; unrelated to Superset, but
  // absent it every parse below would throw for the wrong reason.
  CORS_ORIGIN: "https://app.example.com",
  // Non-default Superset values, so only the field under test is at fault.
  // 32+ characters: production requires it of both signing keys.
  SUPERSET_SECRET_KEY: "a-real-secret-key-of-at-least-32-chars",
  SUPERSET_GUEST_TOKEN_SECRET: "a-real-guest-token-secret-32-chars-min",
  SUPERSET_SERVICE_ACCOUNT_PASSWORD: "a-real-service-account-password",
  SUPERSET_ADMIN_PASSWORD: "a-real-admin-password",
  SUPERSET_SITE_URL: "https://reporting.example.com",
  SUPERSET_INTERNAL_URL: "http://superset:8088",
};

describe("Superset secrets — production default guards", () => {
  it("accepts a production env where every Superset secret is set to a real value", () => {
    const parsed = EnvSchema.parse(PRODUCTION_ENV);
    expect(parsed.NODE_ENV).toBe("production");
    expect(parsed.SUPERSET_SECRET_KEY).toBe(
      "a-real-secret-key-of-at-least-32-chars",
    );
  });

  it.each(Object.keys(DEV_SUPERSET_DEFAULTS))(
    "rejects an empty %s in any environment",
    (varName) => {
      // Empty is not the dev default, so without a length check it would
      // pass the production guards and reach Superset as an empty secret.
      expect(() =>
        EnvSchema.parse({ ...PRODUCTION_ENV, [varName]: "" }),
      ).toThrow(new RegExp(varName));
      expect(() =>
        EnvSchema.parse({ ...MINIMAL_VALID_ENV, [varName]: "" }),
      ).toThrow(new RegExp(varName));
    },
  );

  it.each(["SUPERSET_SECRET_KEY", "SUPERSET_GUEST_TOKEN_SECRET"])(
    "rejects a %s shorter than 32 characters in production",
    (varName) => {
      expect(() =>
        EnvSchema.parse({ ...PRODUCTION_ENV, [varName]: "x".repeat(31) }),
      ).toThrow(new RegExp(`${varName} must be at least 32 characters`));
      expect(
        EnvSchema.parse({ ...PRODUCTION_ENV, [varName]: "x".repeat(32) }),
      ).toBeTruthy();
    },
  );

  it.each(Object.entries(DEV_SUPERSET_DEFAULTS))(
    "rejects %s when it is still the development default in production",
    (varName, devDefault) => {
      // Asserting the variable's own name appears in the error, not just that
      // *something* threw: a bare .toThrow() would pass even if an unrelated
      // production rule was the one rejecting, which would leave this guard
      // untested while looking green.
      expect(() =>
        EnvSchema.parse({ ...PRODUCTION_ENV, [varName]: devDefault }),
      ).toThrow(new RegExp(varName));
    },
  );

  it.each(Object.entries(DEV_SUPERSET_DEFAULTS))(
    "allows %s to keep its development default outside production",
    (varName, devDefault) => {
      // The same value that is fatal in production must not break local dev —
      // otherwise a fresh clone cannot start, which is the whole reason the
      // defaults exist.
      const parsed = EnvSchema.parse({
        ...MINIMAL_VALID_ENV,
        [varName]: devDefault,
      });
      expect(parsed[varName as keyof typeof DEV_SUPERSET_DEFAULTS]).toBe(
        devDefault,
      );
    },
  );

  it("names the offending variable in the error, not just 'invalid env'", () => {
    // A guard that fails without saying which secret is wrong costs a
    // deployment debugging cycle, so the message itself is part of the contract.
    expect(() =>
      EnvSchema.parse({
        ...PRODUCTION_ENV,
        SUPERSET_GUEST_TOKEN_SECRET:
          DEV_SUPERSET_DEFAULTS.SUPERSET_GUEST_TOKEN_SECRET,
      }),
    ).toThrow(/SUPERSET_GUEST_TOKEN_SECRET/);
  });

  it("applies the development defaults when the variables are absent entirely", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.SUPERSET_SECRET_KEY).toBe(
      DEV_SUPERSET_DEFAULTS.SUPERSET_SECRET_KEY,
    );
    expect(parsed.SUPERSET_SITE_URL).toBe("http://localhost:8088");
    // The two URLs differ by default: the browser cannot resolve "superset".
    expect(parsed.SUPERSET_INTERNAL_URL).toBe("http://superset:8088");
  });
});

describe("Superset URLs — production split", () => {
  it("rejects identical site and internal URLs in production", () => {
    expect(() =>
      EnvSchema.parse({
        ...PRODUCTION_ENV,
        SUPERSET_SITE_URL: "https://reporting.example.com",
        SUPERSET_INTERNAL_URL: "https://reporting.example.com",
      }),
    ).toThrow(/must differ in production/);
  });

  it("allows identical URLs outside production", () => {
    // Local dev legitimately reaches Superset on one address from both sides.
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      SUPERSET_SITE_URL: "http://localhost:8088",
      SUPERSET_INTERNAL_URL: "http://localhost:8088",
    });
    expect(parsed.SUPERSET_SITE_URL).toBe(parsed.SUPERSET_INTERNAL_URL);
  });
});

describe("ANTHROPIC_API_KEY", () => {
  it("is optional — the platform starts without AI configured", () => {
    const withoutKey: Record<string, string> = { ...MINIMAL_VALID_ENV };
    delete withoutKey["ANTHROPIC_API_KEY"];
    expect(EnvSchema.parse(withoutKey).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("treats an empty or whitespace value as unset", () => {
    for (const value of ["", "   "]) {
      const parsed = EnvSchema.parse({
        ...MINIMAL_VALID_ENV,
        ANTHROPIC_API_KEY: value,
      });
      expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
    }
  });

  it("keeps a provided key", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      ANTHROPIC_API_KEY: "sk-test",
    });
    expect(parsed.ANTHROPIC_API_KEY).toBe("sk-test");
  });
});

describe("DATABASE_DIRECT_URL / DATABASE_LOCK_POOL_MAX (#752)", () => {
  it("leaves the direct URL unset and defaults the lock pool to 5", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.DATABASE_DIRECT_URL).toBeUndefined();
    expect(parsed.DATABASE_LOCK_POOL_MAX).toBe(5);
  });

  it("accepts a direct Postgres URL and a lock pool override", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      DATABASE_DIRECT_URL: "postgresql://app_user:pw@postgres:5432/platform",
      DATABASE_LOCK_POOL_MAX: "8",
    });
    expect(parsed.DATABASE_DIRECT_URL).toBe(
      "postgresql://app_user:pw@postgres:5432/platform",
    );
    expect(parsed.DATABASE_LOCK_POOL_MAX).toBe(8);
  });

  it("rejects a malformed direct URL and a lock pool below 1", () => {
    expect(() =>
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, DATABASE_DIRECT_URL: "nope" }),
    ).toThrow();
    expect(() =>
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, DATABASE_LOCK_POOL_MAX: "0" }),
    ).toThrow();
  });
});

describe("OpenBao — production guards (ADR-023)", () => {
  it("accepts AppRole over https in production", () => {
    expect(EnvSchema.parse(PRODUCTION_ENV).OPENBAO_TOKEN).toBeUndefined();
  });

  it("rejects the local provider in production", () => {
    expect(() =>
      EnvSchema.parse({ ...PRODUCTION_ENV, SECRETS_PROVIDER: "local" }),
    ).toThrow(/SECRETS_PROVIDER must not be 'local' in production/);
  });

  it("rejects a static OPENBAO_TOKEN in production", () => {
    expect(() =>
      EnvSchema.parse({ ...PRODUCTION_ENV, OPENBAO_TOKEN: "dev-root-token" }),
    ).toThrow(/OPENBAO_TOKEN must not be set in production/);
  });

  it("rejects a plain-http OPENBAO_ADDR in production", () => {
    expect(() =>
      EnvSchema.parse({
        ...PRODUCTION_ENV,
        OPENBAO_ADDR: "http://openbao:8200",
      }),
    ).toThrow(/OPENBAO_ADDR must use https:\/\/ in production/);
  });

  it("rejects the development METRICS_TOKEN in production", () => {
    const { METRICS_TOKEN: _real, ...withoutToken } = PRODUCTION_ENV;
    expect(() => EnvSchema.parse(withoutToken)).toThrow(
      /METRICS_TOKEN must not be its development default in production/,
    );
    expect(() =>
      EnvSchema.parse({ ...PRODUCTION_ENV, METRICS_TOKEN: DEV_METRICS_TOKEN }),
    ).toThrow(/METRICS_TOKEN/);
  });

  it("keeps the dev token, http and the local provider working outside production", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      OPENBAO_ADDR: "http://openbao:8200",
    });
    expect(parsed.OPENBAO_TOKEN).toBe("dev-root-token");
    expect(parsed.METRICS_TOKEN).toBe(DEV_METRICS_TOKEN);
  });

  it("treats empty OpenBao credentials as unset, so the missing-auth check fires at start", () => {
    expect(() =>
      EnvSchema.parse({
        ...MINIMAL_WITHOUT_TOKEN,
        OPENBAO_TOKEN: "",
        OPENBAO_ROLE_ID: " ",
        OPENBAO_SECRET_ID: "",
      }),
    ).toThrow(/Either OPENBAO_TOKEN \(dev\) or both OPENBAO_ROLE_ID/);
  });
});

describe("Superset secrets — least privilege in production (ADR-023)", () => {
  const SUPERSET_KEYS = [
    "SUPERSET_SECRET_KEY",
    "SUPERSET_GUEST_TOKEN_SECRET",
    "SUPERSET_SERVICE_ACCOUNT_PASSWORD",
    "SUPERSET_ADMIN_PASSWORD",
  ] as const;

  it("starts a production service that holds none of them (the worker)", () => {
    const withoutSuperset: Record<string, string> = { ...PRODUCTION_ENV };
    for (const key of SUPERSET_KEYS) delete withoutSuperset[key];
    const parsed = EnvSchema.parse(withoutSuperset);
    for (const key of SUPERSET_KEYS) expect(parsed[key]).toBeUndefined();
  });

  it("never fills in a development default in production", () => {
    const onlyServiceAccount: Record<string, string> = { ...PRODUCTION_ENV };
    for (const key of SUPERSET_KEYS) delete onlyServiceAccount[key];
    onlyServiceAccount["SUPERSET_SERVICE_ACCOUNT_PASSWORD"] = "a-real-password";
    const parsed = EnvSchema.parse(onlyServiceAccount);
    expect(parsed.SUPERSET_SERVICE_ACCOUNT_PASSWORD).toBe("a-real-password");
    expect(parsed.SUPERSET_SECRET_KEY).toBeUndefined();
  });

  it("still checks a value that is set in production", () => {
    const { SUPERSET_GUEST_TOKEN_SECRET: _g, ...rest } = PRODUCTION_ENV;
    expect(() =>
      EnvSchema.parse({ ...rest, SUPERSET_SECRET_KEY: "too-short" }),
    ).toThrow(/SUPERSET_SECRET_KEY must be at least 32 characters/);
  });
});

describe("retention settings (docs/specs/retention-classes.md)", () => {
  it("default to 90/365/2555 days, 5000-row batches and a 50 ms pause", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.RETENTION_DEFAULT_DAYS).toBe(90);
    expect(parsed.RETENTION_COMMENT_DAYS).toBe(365);
    expect(parsed.RETENTION_EVIDENCE_DAYS).toBe(2555);
    expect(parsed.RETENTION_BATCH_SIZE).toBe(5000);
    expect(parsed.RETENTION_BATCH_PAUSE_MS).toBe(50);
  });

  it("reject an evidence window below one year or a zero batch size", () => {
    expect(() =>
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, RETENTION_EVIDENCE_DAYS: "30" }),
    ).toThrow();
    expect(() =>
      EnvSchema.parse({ ...MINIMAL_VALID_ENV, RETENTION_BATCH_SIZE: "0" }),
    ).toThrow();
  });
});

describe("user data export settings (docs/specs/user-data-export.md)", () => {
  it("default to a 7-day TTL, 10000 rows per table and audit included", () => {
    const parsed = EnvSchema.parse(MINIMAL_VALID_ENV);
    expect(parsed.USER_EXPORT_TTL_DAYS).toBe(7);
    expect(parsed.USER_EXPORT_ROW_LIMIT).toBe(10000);
    expect(parsed.USER_EXPORT_INCLUDE_AUDIT).toBe(true);
  });

  it("accept overrides", () => {
    const parsed = EnvSchema.parse({
      ...MINIMAL_VALID_ENV,
      USER_EXPORT_TTL_DAYS: "2",
      USER_EXPORT_ROW_LIMIT: "500",
      USER_EXPORT_INCLUDE_AUDIT: "false",
    });
    expect(parsed.USER_EXPORT_TTL_DAYS).toBe(2);
    expect(parsed.USER_EXPORT_ROW_LIMIT).toBe(500);
    expect(parsed.USER_EXPORT_INCLUDE_AUDIT).toBe(false);
  });

  it("reject a zero TTL, a tiny row limit and a non-boolean audit flag", () => {
    for (const bad of [
      { USER_EXPORT_TTL_DAYS: "0" },
      { USER_EXPORT_ROW_LIMIT: "5" },
      { USER_EXPORT_INCLUDE_AUDIT: "flase" },
    ]) {
      expect(() => EnvSchema.parse({ ...MINIMAL_VALID_ENV, ...bad })).toThrow();
    }
  });
});
