/**
 * Logic behind scripts/connector-credential-set.ts — the first caller of
 * encryptCredential (ADR-023 Decision 8: "an admin CLI first").
 *
 * The database and the vault are passed in, so tests run with fakes and no
 * Postgres/OpenBao. The CLI wires the real @platform/db and @platform/secrets.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Credential keys are identifiers referenced by a connector's
// ConnectorAuthConfig (e.g. "apiKey", "bot_token"), never free text.
const CREDENTIAL_KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export const USAGE =
  "Usage: pnpm credential:set --tenant <tenant-uuid> --connector <connector-uuid> --key <credential-key>  (secret value on stdin)";

export class CredentialSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialSetError";
  }
}

export interface CredentialSetArgs {
  tenantId: string;
  connectorId: string;
  key: string;
}

const FLAGS = {
  "--tenant": "tenantId",
  "--connector": "connectorId",
  "--key": "key",
} as const;

type Flag = keyof typeof FLAGS;

function isFlag(name: string): name is Flag {
  return Object.hasOwn(FLAGS, name);
}

/**
 * Parse `--tenant <uuid> --connector <uuid> --key <name>` (also `--flag=value`).
 * Anything else is rejected — in particular there is no way to pass the
 * secret value as an argument, where it would land in shell history and `ps`.
 */
export function parseCredentialSetArgs(argv: string[]): CredentialSetArgs {
  const values: Partial<Record<Flag, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!isFlag(name)) {
      // Name a mistyped flag, but never echo anything else — a stray
      // positional argument may well be the secret itself.
      const shown = /^--[a-z-]{1,32}$/.test(name) ? ` "${name}"` : "";
      throw new CredentialSetError(
        `Unexpected argument${shown}. The secret value is read from stdin only.\n${USAGE}`,
      );
    }
    if (values[name] !== undefined) {
      throw new CredentialSetError(`${name} given more than once`);
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith("--")) {
      throw new CredentialSetError(`${name} needs a value\n${USAGE}`);
    }
    values[name] = value.trim();
  }

  const tenantId = values["--tenant"] ?? "";
  const connectorId = values["--connector"] ?? "";
  const key = values["--key"] ?? "";
  if (!tenantId || !connectorId || !key) {
    throw new CredentialSetError(USAGE);
  }
  if (!UUID_RE.test(tenantId)) {
    throw new CredentialSetError(`--tenant must be a UUID`);
  }
  if (!UUID_RE.test(connectorId)) {
    // connector_credentials.connector_id is a FK to connector_definitions.id.
    throw new CredentialSetError(
      `--connector must be a connector definition id (UUID)`,
    );
  }
  if (!CREDENTIAL_KEY_RE.test(key)) {
    throw new CredentialSetError(
      `--key must be 1-128 characters of letters, digits, "_", "." or "-"`,
    );
  }
  return { tenantId, connectorId, key };
}

/** The subset of a readable stream this needs (process.stdin satisfies it). */
export interface SecretInput extends AsyncIterable<string | Buffer> {
  isTTY?: boolean;
}

/**
 * Read the secret value from stdin. A terminal is refused rather than
 * prompted: typed input would be echoed. Exactly one trailing newline
 * (from `echo` or a file) is dropped; any other whitespace is kept as part of
 * the value.
 */
export async function readSecretFromStdin(input: SecretInput): Promise<string> {
  if (input.isTTY) {
    throw new CredentialSetError(
      "Pipe the secret value on stdin (it is never read from a terminal, which would echo it), e.g.\n  pnpm credential:set ... < secret.txt",
    );
  }
  let raw = "";
  for await (const chunk of input) {
    raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") {
    throw new CredentialSetError("No secret value received on stdin");
  }
  return value;
}

/**
 * Refuse `SECRETS_PROVIDER=local` in production: its key is published in the
 * repo, so its ciphertext protects nothing (ADR-023 Decision 7).
 */
export function assertProviderAllowed(env: {
  NODE_ENV?: string | undefined;
  SECRETS_PROVIDER?: string | undefined;
}): void {
  if (env.NODE_ENV === "production" && env.SECRETS_PROVIDER === "local") {
    throw new CredentialSetError(
      "SECRETS_PROVIDER=local is not allowed in production — use OpenBao Transit",
    );
  }
}

/**
 * Return `existing` with `key` set to `ciphertext`; every other key is kept
 * as-is. `existing` is the row's raw `secrets` jsonb (`{}` for a new row).
 */
export function mergeSecret(
  existing: unknown,
  key: string,
  ciphertext: string,
): Record<string, unknown> {
  if (
    existing === null ||
    typeof existing !== "object" ||
    Array.isArray(existing)
  ) {
    // Overwriting would silently drop whatever is there.
    throw new CredentialSetError(
      "Existing connector_credentials.secrets is not a JSON object — refusing to overwrite it",
    );
  }
  return { ...(existing as Record<string, unknown>), [key]: ciphertext };
}

export interface CredentialStore {
  /** True when the tenant exists and is active. */
  tenantIsActive(tenantId: string): Promise<boolean>;
  /** True when connector_definitions has this id. */
  connectorDefinitionExists(connectorId: string): Promise<boolean>;
  /**
   * Inside the tenant's RLS context: read the row's current `secrets`
   * (`{}` if there is no row), apply `merge`, and insert or update the row.
   */
  upsertSecrets(
    tenantId: string,
    connectorId: string,
    merge: (existing: unknown) => Record<string, unknown>,
  ): Promise<void>;
}

export interface CredentialSetDeps {
  encrypt(tenantId: string, plaintext: string): Promise<string>;
  store: CredentialStore;
}

/**
 * Validate, encrypt for the tenant, and merge the one key into the tenant's
 * connector row. Returns the line to print — it names the key, never the
 * value or ciphertext.
 */
export async function setConnectorCredential(
  deps: CredentialSetDeps,
  args: CredentialSetArgs,
  value: string,
): Promise<string> {
  const { tenantId, connectorId, key } = args;
  if (!(await deps.store.tenantIsActive(tenantId))) {
    throw new CredentialSetError(`No active tenant ${tenantId}`);
  }
  if (!(await deps.store.connectorDefinitionExists(connectorId))) {
    throw new CredentialSetError(`No connector definition ${connectorId}`);
  }
  // The tenant id is the encryption context (Transit derived key / local AAD),
  // so this ciphertext only decrypts for this tenant.
  const ciphertext = await deps.encrypt(tenantId, value);
  await deps.store.upsertSecrets(tenantId, connectorId, (existing) =>
    mergeSecret(existing, key, ciphertext),
  );
  return `stored key ${key} for connector ${connectorId} (tenant ${tenantId})`;
}
