import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  BootstrapSecretsError,
  SecretsFile,
  assertSecretsFileAvailable,
  assertZitadelCredentialsAvailable,
  hasRealSecret,
  planIntrospectionSecret,
  resolveSecretsDestination,
  secretsDirPermissionWarning,
  splitProducedVars,
} from "./bootstrap-secrets.js";

describe("planIntrospectionSecret", () => {
  it("keeps an existing secret when the rotate flag is not passed", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        rotateRequested: false,
        serviceAccountCreated: false,
        production: false,
        existingSecret: "s3cret",
      }),
      { action: "keep" },
    );
  });

  it("rotates an existing secret when the rotate flag is passed", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        rotateRequested: true,
        serviceAccountCreated: false,
        production: false,
        existingSecret: "s3cret",
      }),
      { action: "generate", reason: "rotate-flag" },
    );
  });

  it("generates when no secret is stored", () => {
    for (const existingSecret of [undefined, "", "   "]) {
      assert.deepEqual(
        planIntrospectionSecret({
          rotateRequested: false,
          serviceAccountCreated: false,
          production: false,
          existingSecret,
        }),
        { action: "generate", reason: "missing" },
      );
    }
  });

  it("treats the .env.example placeholder as missing", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        rotateRequested: false,
        serviceAccountCreated: false,
        production: false,
        existingSecret: "your_introspection_client_secret",
      }),
      { action: "generate", reason: "missing" },
    );
  });

  it("generates when the service account was just created, even if a secret is stored", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        rotateRequested: false,
        serviceAccountCreated: true,
        production: false,
        existingSecret: "stale-from-a-wiped-zitadel",
      }),
      { action: "generate", reason: "new-service-account" },
    );
  });
});

describe("planIntrospectionSecret in production", () => {
  const base = { serviceAccountCreated: false, production: true };

  it("keeps a secret visible in the environment", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        ...base,
        rotateRequested: false,
        existingSecret: "s3cret",
      }),
      { action: "keep" },
    );
  });

  it("leaves an existing service account alone when its secret is not visible", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        ...base,
        rotateRequested: false,
        existingSecret: undefined,
      }),
      { action: "leave", reason: "not-visible-in-production" },
    );
  });

  it("still rotates with the flag, and generates for a new service account", () => {
    assert.deepEqual(
      planIntrospectionSecret({
        ...base,
        rotateRequested: true,
        existingSecret: undefined,
      }),
      { action: "generate", reason: "rotate-flag" },
    );
    assert.deepEqual(
      planIntrospectionSecret({
        ...base,
        serviceAccountCreated: true,
        rotateRequested: false,
        existingSecret: undefined,
      }),
      { action: "generate", reason: "new-service-account" },
    );
  });
});

describe("hasRealSecret", () => {
  it("rejects empty, placeholder and sentinel values", () => {
    assert.equal(hasRealSecret(undefined), false);
    assert.equal(hasRealSecret(""), false);
    assert.equal(hasRealSecret("your_introspection_client_secret"), false);
    assert.equal(hasRealSecret("<existing>"), false);
    assert.equal(hasRealSecret("abc123"), true);
  });
});

describe("resolveSecretsDestination", () => {
  it("uses .env.local outside production, as before", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      assert.deepEqual(
        resolveSecretsDestination({
          NODE_ENV,
          BOOTSTRAP_SECRETS_OUT: "/ignored/outside/production",
        }),
        { kind: "env-local" },
      );
    }
  });

  it("fails in production without BOOTSTRAP_SECRETS_OUT", () => {
    for (const BOOTSTRAP_SECRETS_OUT of [undefined, "", "  "]) {
      assert.throws(
        () =>
          resolveSecretsDestination({
            NODE_ENV: "production",
            BOOTSTRAP_SECRETS_OUT,
          }),
        BootstrapSecretsError,
      );
    }
  });

  it("uses the secrets file in production when BOOTSTRAP_SECRETS_OUT is set", () => {
    assert.deepEqual(
      resolveSecretsDestination({
        NODE_ENV: "production",
        BOOTSTRAP_SECRETS_OUT: "/srv/bootstrap-secrets.json",
      }),
      { kind: "secrets-file", path: "/srv/bootstrap-secrets.json" },
    );
  });
});

describe("splitProducedVars", () => {
  it("separates secrets from config and drops <existing> and empty secrets", () => {
    const { secrets, config } = splitProducedVars({
      ZITADEL_URL: "https://id.example.com",
      ZITADEL_INTROSPECTION_CLIENT_ID: "<existing>",
      ZITADEL_INTROSPECTION_CLIENT_SECRET: "new-secret",
      ZITADEL_OIDC_CLIENT_ID: "client-1",
      ZITADEL_OIDC_CLIENT_SECRET: "",
      ZITADEL_KEY_JSON: "<existing>",
    });
    assert.deepEqual(secrets, {
      ZITADEL_INTROSPECTION_CLIENT_SECRET: "new-secret",
    });
    assert.deepEqual(config, {
      ZITADEL_URL: "https://id.example.com",
      ZITADEL_OIDC_CLIENT_ID: "client-1",
    });
  });
});

describe("SecretsFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bootstrap-secrets-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a JSON file with only the given secrets and returns their names", () => {
    const path = join(dir, "out.json");
    const file = new SecretsFile(path);

    assert.deepEqual(file.write({ ZITADEL_KEY_JSON: "a" }), [
      "ZITADEL_KEY_JSON",
    ]);
    assert.deepEqual(file.write({ ZITADEL_INTROSPECTION_CLIENT_SECRET: "b" }), [
      "ZITADEL_INTROSPECTION_CLIENT_SECRET",
    ]);

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      ZITADEL_KEY_JSON: "a",
      ZITADEL_INTROSPECTION_CLIENT_SECRET: "b",
    });
    assert.deepEqual(file.keyNames, [
      "ZITADEL_KEY_JSON",
      "ZITADEL_INTROSPECTION_CLIENT_SECRET",
    ]);
  });

  // Windows has no POSIX permission bits, so the mode can only be checked
  // where it means something.
  it(
    "creates the file with mode 0600",
    { skip: process.platform === "win32" && "no POSIX modes on Windows" },
    () => {
      const path = join(dir, "out.json");
      new SecretsFile(path).write({ ZITADEL_KEY_JSON: "a" });
      assert.equal(statSync(path).mode & 0o777, 0o600);
    },
  );

  it("does not create a file when there is nothing to write", () => {
    const path = join(dir, "out.json");
    assert.deepEqual(new SecretsFile(path).write({}), []);
    assert.doesNotThrow(() => assertSecretsFileAvailable(path));
  });

  it("refuses to overwrite a file that already exists", () => {
    const path = join(dir, "out.json");
    writeFileSync(path, "operator data");

    assert.throws(
      () => assertSecretsFileAvailable(path),
      BootstrapSecretsError,
    );
    assert.throws(
      () => new SecretsFile(path).write({ ZITADEL_KEY_JSON: "a" }),
      /EEXIST/,
    );
    assert.equal(readFileSync(path, "utf8"), "operator data");
  });

  it("rejects a path whose directory does not exist", () => {
    assert.throws(
      () => assertSecretsFileAvailable(join(dir, "missing", "out.json")),
      BootstrapSecretsError,
    );
  });
});

describe("secretsDirPermissionWarning", () => {
  const posix = process.platform !== "win32";

  it(
    "warns when group or others can access the directory",
    { skip: !posix },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "bootstrap-dir-"));
      try {
        chmodSync(dir, 0o755);
        const warning = secretsDirPermissionWarning(dir);
        assert.ok(warning);
        assert.match(warning, /mode 755/);
        assert.ok(
          !warning.includes(dir),
          "the message must not include the path",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("is quiet for a 0700 directory", { skip: !posix }, () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-dir-"));
    try {
      chmodSync(dir, 0o700);
      assert.equal(secretsDirPermissionWarning(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never warns on Windows, which has no POSIX modes", () => {
    assert.equal(secretsDirPermissionWarning(tmpdir(), "win32"), undefined);
  });
});

describe("assertZitadelCredentialsAvailable", () => {
  it("accepts a key from OpenBao", () => {
    assert.doesNotThrow(() =>
      assertZitadelCredentialsAvailable({
        ZITADEL_KEY_JSON: "eyJrZXkiOiJ4In0=",
      }),
    );
  });

  it("accepts a one-time setup PAT on the first run", () => {
    assert.doesNotThrow(() =>
      assertZitadelCredentialsAvailable({ ZITADEL_SETUP_PAT: "pat-value" }),
    );
  });

  it("stops before any change when neither is present", () => {
    assert.throws(
      () =>
        assertZitadelCredentialsAvailable({
          ZITADEL_KEY_JSON: "",
          ZITADEL_SETUP_PAT: " ",
        }),
      (err: unknown) =>
        err instanceof BootstrapSecretsError &&
        /No Zitadel credentials/.test(err.message),
    );
  });
});
