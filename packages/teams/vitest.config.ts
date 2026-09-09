import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL:
        "postgresql://platform:platform_test_password@localhost:5432/platform_test",
      DATABASE_POOL_MIN: "1",
      DATABASE_POOL_MAX: "3",
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
    },
  },
});
