/**
 * Secret-handling decisions for scripts/bootstrap.ts (ADR-023 Decision 6:
 * bootstrap must not regenerate the Zitadel introspection secret on every run,
 * and must not write secrets to .env.local in production).
 *
 * Kept free of Zitadel calls and process globals so each decision can be
 * unit-tested without a running stack.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** CLI flag that forces a new introspection client secret. */
export const ROTATE_INTROSPECTION_FLAG = "--rotate-introspection-secret";

/**
 * Env vars bootstrap produces whose values are secrets. In production these go
 * to the BOOTSTRAP_SECRETS_OUT file; every other var bootstrap produces is
 * non-secret config (URLs, project id, client ids).
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "ZITADEL_KEY_JSON",
  "ZITADEL_SERVICE_ACCOUNT_KEY",
  "ZITADEL_INTROSPECTION_CLIENT_SECRET",
  "ZITADEL_OIDC_CLIENT_SECRET",
]);

/** writeEnvVars' "leave the current value alone" sentinel. */
function isExistingSentinel(value: string): boolean {
  return value.startsWith("<existing");
}

/**
 * True when a secret value is really there. Empty values and the
 * .env.example placeholders (`your_introspection_client_secret`) count as
 * absent — .env.local starts as a copy of .env.example, so a first run would
 * otherwise "keep" a placeholder.
 */
export function hasRealSecret(value: string | undefined): value is string {
  const v = value?.trim() ?? "";
  return v !== "" && !v.startsWith("your_") && !isExistingSentinel(v);
}

export type IntrospectionSecretPlan =
  | { action: "keep" }
  | {
      action: "generate";
      reason: "rotate-flag" | "new-service-account" | "missing";
    }
  | { action: "leave"; reason: "not-visible-in-production" };

/**
 * Decide whether to call Zitadel's PUT /users/{id}/secret, which invalidates
 * the previous secret. Only when the operator asked for it, the service
 * account was just created (any stored secret belongs to an account that no
 * longer exists, e.g. after `docker compose down -v`), or no secret is stored.
 *
 * In production a secret bootstrap can't see is not proof there is none —
 * it lives in OpenBao, possibly at another service's path — so an existing
 * service account's secret is only replaced with the explicit flag.
 */
export function planIntrospectionSecret(input: {
  rotateRequested: boolean;
  serviceAccountCreated: boolean;
  existingSecret: string | undefined;
  production: boolean;
}): IntrospectionSecretPlan {
  if (input.rotateRequested) {
    return { action: "generate", reason: "rotate-flag" };
  }
  if (input.serviceAccountCreated) {
    return { action: "generate", reason: "new-service-account" };
  }
  if (hasRealSecret(input.existingSecret)) return { action: "keep" };
  return input.production
    ? { action: "leave", reason: "not-visible-in-production" }
    : { action: "generate", reason: "missing" };
}

export class BootstrapSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapSecretsError";
  }
}

export type SecretsDestination =
  | { kind: "env-local" }
  | { kind: "secrets-file"; path: string };

/**
 * Where newly produced secrets go. Outside production: .env.local, as before.
 * In production: the file named by BOOTSTRAP_SECRETS_OUT, which must be set —
 * throwing here (before bootstrap touches Zitadel) means nothing is created or
 * rotated without somewhere safe to put the new value.
 */
export function resolveSecretsDestination(env: {
  NODE_ENV?: string | undefined;
  BOOTSTRAP_SECRETS_OUT?: string | undefined;
}): SecretsDestination {
  if (env.NODE_ENV !== "production") return { kind: "env-local" };
  const path = env.BOOTSTRAP_SECRETS_OUT?.trim() ?? "";
  if (path === "") {
    throw new BootstrapSecretsError(
      "NODE_ENV=production requires BOOTSTRAP_SECRETS_OUT (a path for a new file that will receive any secrets this run creates). Bootstrap never writes .env.local in production.",
    );
  }
  return { kind: "secrets-file", path };
}

/** Fail early if the secrets file can't be created later (before any rotation). */
export function assertSecretsFileAvailable(path: string): void {
  if (existsSync(path)) {
    throw new BootstrapSecretsError(
      `BOOTSTRAP_SECRETS_OUT file already exists: ${path}. Load it into OpenBao and delete it, or choose a new path — bootstrap will not overwrite it.`,
    );
  }
  if (!existsSync(dirname(path))) {
    throw new BootstrapSecretsError(
      `Directory for BOOTSTRAP_SECRETS_OUT does not exist: ${dirname(path)}`,
    );
  }
}

/**
 * Split a writeEnvVars-style map into secrets (for the secrets file) and
 * non-secret config. `<existing>` sentinels are dropped from both — nothing new
 * was produced for them. Empty secret values are dropped too (a public OIDC app
 * has no client secret; a failed secret generation yields "").
 */
export function splitProducedVars(vars: Record<string, string>): {
  secrets: Record<string, string>;
  config: Record<string, string>;
} {
  const secrets: Record<string, string> = {};
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (isExistingSentinel(value)) continue;
    if (SECRET_ENV_KEYS.has(key)) {
      if (value !== "") secrets[key] = value;
    } else {
      config[key] = value;
    }
  }
  return { secrets, config };
}

/**
 * Production sink for new secrets: a JSON object (key -> value) in a file
 * created with mode 0600 that must not already exist. Each write rewrites the
 * whole file so a value is on disk as soon as it is produced — a later step
 * failing can't lose a secret that has already been rotated in Zitadel.
 */
export class SecretsFile {
  private readonly entries: Record<string, string> = {};
  private created = false;

  constructor(readonly path: string) {}

  /** Adds `secrets` to the file and returns the key names written. */
  write(secrets: Record<string, string>): string[] {
    const names = Object.keys(secrets);
    if (names.length === 0) return [];
    Object.assign(this.entries, secrets);
    writeFileSync(this.path, `${JSON.stringify(this.entries, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      // "wx" fails if the file exists, so a pre-existing file is never
      // overwritten; after our own first write, rewrite the file we created.
      flag: this.created ? "w" : "wx",
    });
    this.created = true;
    return names;
  }

  /** Every key name written so far. */
  get keyNames(): string[] {
    return Object.keys(this.entries);
  }
}
