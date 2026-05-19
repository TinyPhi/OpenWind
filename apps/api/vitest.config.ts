import { defineConfig } from "vitest/config";
import path from "path";

const packages = path.resolve(__dirname, "../../packages");

export default defineConfig({
  resolve: {
    // Point workspace packages to their TypeScript source so that all
    // imports — both in test files and in dynamically-loaded modules under
    // test — resolve to the same entry point and share a single module
    // instance. Without this, different module loaders (Vite vs Node native
    // ESM) can produce separate class objects, breaking instanceof checks.
    alias: {
      "@platform/workflow-engine": path.join(
        packages,
        "workflow-engine/src/index.ts",
      ),
      "@platform/entity-engine": path.join(
        packages,
        "entity-engine/src/index.ts",
      ),
      "@platform/logger": path.join(packages, "logger/src/index.ts"),
      "@platform/auth": path.join(packages, "auth/src/index.ts"),
      "@platform/db": path.join(packages, "db/src/index.ts"),
      "@platform/config": path.join(packages, "config/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // Provide all required @platform/config env vars so tests don't need to
    // vi.mock the config module. CI job env vars take precedence over these
    // defaults when set (e.g. the real DATABASE_URL in integration jobs).
    env: {
      DATABASE_URL:
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
