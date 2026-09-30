// This is a standalone CLI script — direct process.env access is intentional
// (it cannot use @platform/config which requires all app env vars).
/* eslint-disable no-restricted-syntax */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "path";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Load .env.local from the monorepo root (walk up from cwd/dirname until we find it)
function findEnvLocal(): string | undefined {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envLocalPath = findEnvLocal();
if (envLocalPath) {
  loadDotenv({ path: envLocalPath, override: false });
}

const migrationsFolder = path.join(__dirname, "../migrations");

// Superset signs each reporting connection's tenant binding with this secret and
// the database verifies it (migration 0128). The copy the database holds lives in
// reporting_binding_key, which only the verifying function can read. Unset means
// reporting connections see no rows (fail closed), never all rows.
async function syncReportingBindingKey(client: postgres.Sql): Promise<void> {
  const secret = process.env["REPORTING_BINDING_SECRET"]?.trim() ?? "";
  if (secret === "") {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "REPORTING_BINDING_SECRET must be set in production — reporting connections see no rows without it",
      );
    }
    console.error(
      "REPORTING_BINDING_SECRET is not set — reporting connections will see no rows until it is.",
    );
    return;
  }
  if (secret.length < 32) {
    throw new Error("REPORTING_BINDING_SECRET must be at least 32 characters");
  }
  if (
    process.env["NODE_ENV"] === "production" &&
    secret === "reporting_binding_dev_secret_change_me_0001"
  ) {
    throw new Error(
      "REPORTING_BINDING_SECRET is still the development default — set a real secret in production",
    );
  }
  await client`
    INSERT INTO reporting_binding_key (id, secret, updated_at)
    VALUES (1, ${secret}, now())
    ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret, updated_at = now()`;
  console.error("Reporting binding key synced.");
}

async function main(): Promise<void> {
  const url =
    process.env["MIGRATION_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL or MIGRATION_DATABASE_URL is not set");
    process.exit(1);
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.error("Running migrations from:", migrationsFolder);

  try {
    await migrate(db, { migrationsFolder });
    console.error("All migrations applied successfully.");
    await syncReportingBindingKey(client);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

void main();
