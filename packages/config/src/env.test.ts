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

describe("RATE_LIMIT_TENANT_PER_MIN (PR #375 review M1)", () => {
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
