#!/usr/bin/env tsx
/**
 * connector-credential-set.ts — create or update one connector credential for
 * one tenant (ADR-023 Decision 8's admin CLI; issue #368's connectors UI comes
 * later).
 *
 *   pnpm credential:set --tenant <tenant-uuid> --connector <connector-uuid> --key <credential-key> < secret.txt
 *
 * The secret value is read from stdin only — never from arguments (shell
 * history, `ps`) and never from a terminal (echo). It is encrypted with
 * encryptCredential(tenantId, value), so the ciphertext is bound to that
 * tenant, then merged into connector_credentials.secrets under --key inside
 * withTenantContext (RLS). Other keys in the row are left untouched. Only the
 * key name is printed — never the value or ciphertext.
 */
import {
  CredentialSetError,
  assertProviderAllowed,
  parseCredentialSetArgs,
  readSecretFromStdin,
  setConnectorCredential,
  type CredentialStore,
} from "./lib/connector-credential.js";

// @platform/db and @platform/secrets validate the whole environment when
// imported, so they are loaded only after the arguments and stdin are checked
// — a usage mistake gets a usage message, not a config dump.
async function createStore(): Promise<CredentialStore> {
  const {
    withTenantContext,
    isTenantActive,
    connectorCredentials,
    connectorDefinitionExists,
    connectorInstallationFilter,
  } = await import("@platform/db");

  return {
    tenantIsActive: (tenantId) => isTenantActive(tenantId),

    connectorDefinitionExists: (connectorId) =>
      connectorDefinitionExists(connectorId),

    upsertSecrets: (tenantId, connectorId, merge) =>
      withTenantContext(tenantId, async (tx) => {
        // FOR UPDATE: a concurrent run for another key on the same row waits
        // here instead of overwriting this run's merge.
        const [row] = await tx
          .select({ secrets: connectorCredentials.secrets })
          .from(connectorCredentials)
          .where(connectorInstallationFilter(tenantId, connectorId))
          .for("update");
        const secrets = merge(row?.secrets ?? {});
        await tx
          .insert(connectorCredentials)
          .values({ tenantId, connectorId, secrets })
          .onConflictDoUpdate({
            target: [
              connectorCredentials.tenantId,
              connectorCredentials.connectorId,
            ],
            set: { secrets, updatedAt: new Date() },
          });
      }),
  };
}

async function main(): Promise<void> {
  const args = parseCredentialSetArgs(process.argv.slice(2));
  assertProviderAllowed({
    NODE_ENV: process.env["NODE_ENV"],
    SECRETS_PROVIDER: process.env["SECRETS_PROVIDER"],
  });
  const value = await readSecretFromStdin(process.stdin);
  const store = await createStore();
  const { encryptCredential } = await import("@platform/secrets");
  const message = await setConnectorCredential(
    { encrypt: encryptCredential, store },
    args,
    value,
  );
  console.log(message);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Our own errors are safe to print; anything else is printed by name and
    // message only, so a stack or driver error can't carry the value along.
    if (err instanceof CredentialSetError) {
      console.error(err.message);
    } else {
      console.error(
        err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error",
      );
    }
    process.exit(1);
  });
