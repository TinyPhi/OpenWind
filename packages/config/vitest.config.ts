import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // env.ts parses process.env at module load time as a side effect
    // (`export const env = EnvSchema.parse(process.env)`) — importing the
    // module to reach the exported EnvSchema for direct testing still runs
    // that side effect, so a minimal valid fixture is required here even
    // though env.test.ts calls EnvSchema.parse() itself with its own object.
    env: {
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
    },
  },
});
