/**
 * Read-only check that must pass before the production `local:` decrypt guard
 * is relied on (ADR-023 Decision 7).
 *
 * `local:` ciphertext is encrypted with a key published in this repo, and
 * production refuses to decrypt it. This counts connector credentials that
 * still hold any `local:` value, so they can be re-entered with the OpenBao
 * provider first instead of failing at decrypt. It prints counts only, never
 * values, and runs in a read-only transaction.
 *
 * Needs a role that is not subject to RLS on connector_credentials (the
 * migration role), since it counts across every tenant:
 *
 *   MIGRATION_DATABASE_URL=... pnpm --filter @platform/db db:check-local-ciphertext
 *
 * Exit code 0 when no `local:` values exist, 1 when some do, 2 on error.
 */
// A standalone ops script like run-migrations.ts: it must not import
// @platform/config, whose schema requires the full application environment.
/* eslint-disable no-restricted-syntax */
import postgres from "postgres";

async function main(): Promise<number> {
  const url = process.env["MIGRATION_DATABASE_URL"];
  if (!url) {
    console.error("MIGRATION_DATABASE_URL is not set");
    return 2;
  }

  const client = postgres(url, { max: 1 });
  try {
    const [row] = await client.begin(
      "read only",
      (sql) => sql<{ credentials: number; tenants: number }[]>`
      SELECT count(DISTINCT c.id)::int        AS credentials,
             count(DISTINCT c.tenant_id)::int AS tenants
      FROM connector_credentials c,
           jsonb_each_text(c.secrets) AS s(key, value)
      WHERE s.value LIKE 'local:%'`,
    );

    const credentials = row?.credentials ?? 0;
    const tenants = row?.tenants ?? 0;
    if (credentials === 0) {
      console.error("OK: no connector credentials hold local: ciphertext.");
      return 0;
    }
    console.error(
      `FOUND: ${credentials} connector credential(s) across ${tenants} tenant(s) hold local: ciphertext. Re-enter them with the OpenBao provider before running production.`,
    );
    return 1;
  } catch (err) {
    console.error("Check failed:", err);
    return 2;
  } finally {
    await client.end();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
