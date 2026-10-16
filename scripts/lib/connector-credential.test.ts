import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
// The local provider is pure node:crypto, so the real implementation runs here
// with no OpenBao. Deep import of the built module: the package entry point
// (transit.ts) validates the whole app environment on import. Needs
// `pnpm turbo run build --filter=@platform/secrets` first.
import {
  encryptCredentialLocal,
  decryptCredentialLocal,
} from "@platform/secrets/dist/local.js";
import {
  CredentialSetError,
  assertProviderAllowed,
  mergeSecret,
  parseCredentialSetArgs,
  readSecretFromStdin,
  setConnectorCredential,
  type CredentialSetDeps,
} from "./connector-credential.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const VALUE = "super-secret-value";

const ARGS = [
  "--tenant",
  TENANT_A,
  "--connector",
  CONNECTOR,
  "--key",
  "apiKey",
];

function stdin(text: string, isTTY = false): Readable & { isTTY: boolean } {
  return Object.assign(Readable.from([Buffer.from(text)]), { isTTY });
}

interface FakeDb {
  deps: CredentialSetDeps;
  rows: Map<string, unknown>;
  encryptCalls: Array<[string, string]>;
}

/** In-memory stand-in for @platform/db + @platform/secrets. */
function fakeDeps(
  opts: {
    tenantActive?: boolean;
    connectorExists?: boolean;
    existing?: unknown;
  } = {},
): FakeDb {
  const rows = new Map<string, unknown>();
  if (opts.existing !== undefined) {
    rows.set(`${TENANT_A}/${CONNECTOR}`, opts.existing);
  }
  const encryptCalls: Array<[string, string]> = [];
  return {
    rows,
    encryptCalls,
    deps: {
      encrypt: (tenantId, plaintext) => {
        encryptCalls.push([tenantId, plaintext]);
        return Promise.resolve(`ct(${tenantId})`);
      },
      store: {
        tenantIsActive: () => Promise.resolve(opts.tenantActive ?? true),
        connectorDefinitionExists: () =>
          Promise.resolve(opts.connectorExists ?? true),
        upsertSecrets: (tenantId, connectorId, merge) => {
          const id = `${tenantId}/${connectorId}`;
          rows.set(id, merge(rows.get(id) ?? {}));
          return Promise.resolve();
        },
      },
    },
  };
}

describe("parseCredentialSetArgs", () => {
  it("parses --flag value and --flag=value forms", () => {
    const expected = {
      tenantId: TENANT_A,
      connectorId: CONNECTOR,
      key: "apiKey",
    };
    assert.deepEqual(parseCredentialSetArgs(ARGS), expected);
    assert.deepEqual(
      parseCredentialSetArgs([
        `--tenant=${TENANT_A}`,
        `--connector=${CONNECTOR}`,
        "--key=apiKey",
      ]),
      expected,
    );
  });

  it("has no way to pass the secret value as an argument", () => {
    for (const extra of [["--value", VALUE], [`--secret=${VALUE}`], [VALUE]]) {
      assert.throws(
        () => parseCredentialSetArgs([...ARGS, ...extra]),
        (err: unknown) =>
          err instanceof CredentialSetError &&
          /stdin only/.test(err.message) &&
          !err.message.includes(VALUE),
      );
    }
  });

  it("rejects a non-UUID tenant or connector", () => {
    assert.throws(
      () => parseCredentialSetArgs(["--tenant", "acme", ...ARGS.slice(2)]),
      /--tenant must be a UUID/,
    );
    assert.throws(
      () =>
        parseCredentialSetArgs([
          "--tenant",
          TENANT_A,
          "--connector",
          "slack",
          "--key",
          "apiKey",
        ]),
      /--connector must be/,
    );
  });

  it("rejects missing, empty, or malformed keys and missing flags", () => {
    assert.throws(() => parseCredentialSetArgs(ARGS.slice(0, 4)), /Usage/);
    assert.throws(
      () => parseCredentialSetArgs([...ARGS.slice(0, 4), "--key="]),
      /Usage/,
    );
    assert.throws(
      () => parseCredentialSetArgs([...ARGS.slice(0, 4), "--key", "has space"]),
      /--key must be/,
    );
    assert.throws(
      () => parseCredentialSetArgs([...ARGS.slice(0, 4), "--key"]),
      /needs a value/,
    );
    assert.throws(
      () => parseCredentialSetArgs([...ARGS, "--key", "other"]),
      /more than once/,
    );
  });
});

describe("readSecretFromStdin", () => {
  it("reads the value from stdin, dropping one trailing newline", async () => {
    assert.equal(await readSecretFromStdin(stdin(`${VALUE}\n`)), VALUE);
    assert.equal(await readSecretFromStdin(stdin(`${VALUE}\r\n`)), VALUE);
    assert.equal(await readSecretFromStdin(stdin(` ${VALUE} `)), ` ${VALUE} `);
  });

  it("refuses a terminal so typed input is never echoed", async () => {
    await assert.rejects(
      readSecretFromStdin(stdin(VALUE, true)),
      /Pipe the secret/,
    );
  });

  it("rejects an empty value", async () => {
    await assert.rejects(readSecretFromStdin(stdin("")), /No secret value/);
    await assert.rejects(readSecretFromStdin(stdin("\n")), /No secret value/);
  });
});

describe("assertProviderAllowed", () => {
  it("refuses the local provider only in production", () => {
    assert.throws(
      () =>
        assertProviderAllowed({
          NODE_ENV: "production",
          SECRETS_PROVIDER: "local",
        }),
      CredentialSetError,
    );
    assert.doesNotThrow(() =>
      assertProviderAllowed({
        NODE_ENV: "production",
        SECRETS_PROVIDER: "openbao",
      }),
    );
    assert.doesNotThrow(() =>
      assertProviderAllowed({
        NODE_ENV: "development",
        SECRETS_PROVIDER: "local",
      }),
    );
  });
});

describe("mergeSecret", () => {
  it("sets the key and keeps every other key untouched", () => {
    assert.deepEqual(
      mergeSecret(
        { botToken: "ct-old-bot", apiKey: "ct-old" },
        "apiKey",
        "ct-new",
      ),
      { botToken: "ct-old-bot", apiKey: "ct-new" },
    );
  });

  it("refuses to overwrite a secrets value that is not an object", () => {
    for (const bad of [null, [], "x", 1]) {
      assert.throws(() => mergeSecret(bad, "apiKey", "ct"), CredentialSetError);
    }
  });
});

describe("setConnectorCredential", () => {
  it("encrypts for the tenant and merges into existing secrets", async () => {
    const db = fakeDeps({ existing: { botToken: "ct-bot" } });
    const args = parseCredentialSetArgs(ARGS);

    const message = await setConnectorCredential(db.deps, args, VALUE);

    assert.deepEqual(db.encryptCalls, [[TENANT_A, VALUE]]);
    assert.deepEqual(db.rows.get(`${TENANT_A}/${CONNECTOR}`), {
      botToken: "ct-bot",
      apiKey: `ct(${TENANT_A})`,
    });
    assert.equal(
      message,
      `stored key apiKey for connector ${CONNECTOR} (tenant ${TENANT_A})`,
    );
    assert.ok(!message.includes(VALUE) && !message.includes("ct("));
  });

  it("creates the row when the tenant has none for this connector", async () => {
    const db = fakeDeps();
    await setConnectorCredential(db.deps, parseCredentialSetArgs(ARGS), VALUE);
    assert.deepEqual(db.rows.get(`${TENANT_A}/${CONNECTOR}`), {
      apiKey: `ct(${TENANT_A})`,
    });
  });

  it("rejects an unknown or inactive tenant before encrypting or writing", async () => {
    const db = fakeDeps({ tenantActive: false });
    await assert.rejects(
      setConnectorCredential(db.deps, parseCredentialSetArgs(ARGS), VALUE),
      /No active tenant/,
    );
    assert.equal(db.encryptCalls.length, 0);
    assert.equal(db.rows.size, 0);
  });

  it("rejects an unknown connector definition before encrypting or writing", async () => {
    const db = fakeDeps({ connectorExists: false });
    await assert.rejects(
      setConnectorCredential(db.deps, parseCredentialSetArgs(ARGS), VALUE),
      /No connector definition/,
    );
    assert.equal(db.encryptCalls.length, 0);
    assert.equal(db.rows.size, 0);
  });
});

describe("tenant binding (local provider)", () => {
  it("a value encrypted for tenant A decrypts for A but not for B", async () => {
    const ciphertext = await encryptCredentialLocal(TENANT_A, VALUE);

    assert.ok(!ciphertext.includes(VALUE));
    assert.equal(await decryptCredentialLocal(TENANT_A, ciphertext), VALUE);
    // AES-GCM auth fails: the tenant id is the AAD. (decryptCredentialLocal
    // throws synchronously, hence the async wrapper.)
    await assert.rejects(
      async () => decryptCredentialLocal(TENANT_B, ciphertext),
      /unable to authenticate data/,
    );
  });
});
