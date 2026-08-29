import { defineConfig } from "vitest/config";
import path from "path";
import os from "os";

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
      "@platform/automation-engine": path.join(
        packages,
        "automation-engine/src/index.ts",
      ),
      "@platform/logger": path.join(packages, "logger/src/index.ts"),
      "@platform/redis": path.join(packages, "redis/src/index.ts"),
      "@platform/auth": path.join(packages, "auth/src/index.ts"),
      "@platform/db": path.join(packages, "db/src/index.ts"),
      "@platform/config": path.join(packages, "config/src/index.ts"),
      "@platform/files": path.join(packages, "files/src/index.ts"),
      "@platform/audit": path.join(packages, "audit/src/index.ts"),
      "@platform/notifications": path.join(
        packages,
        "notifications/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    // Provide all required @platform/config env vars so tests don't need to
    // vi.mock the config module. CI job env vars take precedence over these
    // defaults when set (e.g. the real DATABASE_URL in integration jobs).
    env: {
      DATABASE_URL:
        // Allow CI job env to override the local default — vitest env block
        // would otherwise win over the runner's process.env, breaking CI auth.
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
      // Still required by @platform/config's schema — apps/worker/src/export-worker.ts
      // uploads bulk exports to S3 and hasn't moved to local-disk storage (only file
      // attachments did). Not read by anything under apps/api's own tests, but the
      // schema validates the whole process env eagerly on import.
      S3_ENDPOINT: "http://localhost:9000",
      S3_BUCKET: "test",
      S3_ACCESS_KEY: "test",
      S3_SECRET_KEY: "test",
      // Schema default is /data/files (the container bind-mount target) --
      // unwritable outside ow-backend/ow-worker's containers, which breaks
      // integration/upload-flow.test.ts and integration/quarantine-flow.test.ts
      // in CI and any local host-mode `pnpm test` run. os.tmpdir() is always
      // writable and gitignored by nature (outside the repo).
      FILES_STORAGE_PATH:
        process.env["FILES_STORAGE_PATH"] ??
        path.join(os.tmpdir(), "openwind-test-files"),
      ANTHROPIC_API_KEY: "test",
      OPENBAO_ADDR: "http://localhost:8200",
      OPENBAO_TOKEN: "dev-root-token",
      APP_URL: "https://platform.example.com",
      // ADR-012 Phase G, ADR-013 -- fileParallelism is false (below), so every
      // isolation test file in a CI run shares one Redis instance with no
      // flush between files. Many third-party isolation test files reuse the
      // same fixed api-key/acting-person fixture identities (established
      // convention across this suite) and issue well over the production
      // defaults' worth of requests per run. Without this override the
      // per-key and per-(key,person) tiers -- which are correctly strict in
      // production -- start 429ing unrelated functional tests partway
      // through a run. Rate-limit-specific tests set their own low
      // thresholds directly against Redis rather than relying on this value.
      RATE_LIMIT_API_KEY_PER_MIN: "5000",
      RATE_LIMIT_API_KEY_PERSON_PER_MIN: "5000",
    },
  },
});
