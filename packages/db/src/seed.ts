// Standalone CLI seed script — direct process.env access is intentional
// (it cannot use @platform/config which requires all app env vars at boot time).
/* eslint-disable no-restricted-syntax */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tenants } from "./schema/index.js";

// Load .env.local from monorepo root (same pattern as run-migrations.ts)
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

// Fixed UUID for the dev tenant — matches DEV_TENANT_ID in .env.local
const DEV_TENANT_ID = "00000000-0000-0000-0000-000000000001";

async function seed(): Promise<void> {
  const url =
    process.env["MIGRATION_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL or MIGRATION_DATABASE_URL is not set");
    process.exit(1);
  }

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.warn("Seeding development data...");

  await db
    .insert(tenants)
    .values({
      id: DEV_TENANT_ID,
      name: "Demo Company",
      slug: "demo",
      plan: "standard",
    })
    .onConflictDoNothing();

  console.warn("Seed complete.");
  await client.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
