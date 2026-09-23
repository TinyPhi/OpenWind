import { describe, it, expect } from "vitest";
import { EnvSchema, DEV_SUPERSET_DEFAULTS } from "./env.js";

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
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "test",
  S3_ACCESS_KEY: "test",
  S3_SECRET_KEY: "test",
  ANTHROPIC_API_KEY: "test",
  OPENBAO_ADDR: "http://localhost:8200",
  OPENBAO_TOKEN: "dev-root-token",
};

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
const PRODUCTION_ENV = {
  ...MINIMAL_VALID_ENV,
  NODE_ENV: "production",
  // Required in production by an existing refine; unrelated to Superset, but
  // absent it every parse below would throw for the wrong reason.
  CORS_ORIGIN: "https://app.example.com",
  // Non-default Superset values, so only the field under test is at fault.
  SUPERSET_SECRET_KEY: "a-real-secret-key",
  SUPERSET_GUEST_TOKEN_SECRET: "a-real-guest-token-secret",
  SUPERSET_SERVICE_ACCOUNT_PASSWORD: "a-real-service-account-password",
  SUPERSET_ADMIN_PASSWORD: "a-real-admin-password",
  SUPERSET_SITE_URL: "https://reporting.example.com",
  SUPERSET_INTERNAL_URL: "http://superset:8088",
};

describe("Superset secrets — production default guards", () => {
  it("accepts a production env where every Superset secret is set to a real value", () => {
    const parsed = EnvSchema.parse(PRODUCTION_ENV);
    expect(parsed.NODE_ENV).toBe("production");
    expect(parsed.SUPERSET_SECRET_KEY).toBe("a-real-secret-key");
  });

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
