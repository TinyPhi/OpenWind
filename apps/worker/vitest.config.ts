import { defineConfig } from "vitest/config";

// The real outbox poller is deliberately cross-tenant: it claims any tenant's undelivered rows.
// Two test files that each start one would race for each other's rows when vitest runs files in
// parallel (the intermittent #873 failure), so those files run one at a time in their own project.
const POLLER_TESTS = ["tests/isolation/outbox-poller-*.isolation.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "worker",
          include: ["src/**/*.test.ts", "tests/isolation/**/*.test.ts"],
          exclude: POLLER_TESTS,
        },
      },
      {
        extends: true,
        test: {
          name: "outbox-poller",
          include: POLLER_TESTS,
          fileParallelism: false,
        },
      },
    ],
    // Isolation tests import the real @platform/db (no mocking, per
    // testing-conventions.md) and need @platform/config's full required env
    // set to resolve — mirrors apps/api/vitest.config.ts's block.
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgresql://platform:platform_test_password@localhost:5432/platform_test",
      DATABASE_POOL_MIN: "1",
      DATABASE_POOL_MAX: "3",
      REDIS_URL: "redis://localhost:6379",
      NODE_ENV: "test",
      ZITADEL_ISSUER: "http://localhost:8080",
      ZITADEL_AUDIENCE: "platform-api",
      ZITADEL_INTROSPECTION_URL: "http://localhost:8080/oauth/v2/introspect",
      ZITADEL_INTROSPECTION_CLIENT_ID: "test-client-id",
      ZITADEL_INTROSPECTION_CLIENT_SECRET: "test-client-secret",
      NOVU_API_KEY: "test",
      ANTHROPIC_API_KEY: "test",
      OPENBAO_ADDR: "http://localhost:8200",
      OPENBAO_TOKEN: "dev-root-token",
      APP_URL: "https://platform.example.com",
    },
    server: {
      deps: {
        // Inline all @platform/* packages so vitest resolves them from source
        // rather than requiring a pre-built dist/ — without this, instanceof
        // checks and module-boundary types fail across the loader boundary.
        inline: [/^@platform\//],
      },
    },
  },
});
