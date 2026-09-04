import { describe, it, expect } from "vitest";
import { EnvSchema } from "./env.js";

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
