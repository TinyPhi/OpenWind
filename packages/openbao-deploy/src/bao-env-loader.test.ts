import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:https";
import type { ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

// Both loaders are exercised end to end: a real loader process against a local
// HTTPS server that plays OpenBao. TLS matters (the loaders refuse http), so a
// throwaway self-signed certificate is generated with openssl.

const here = dirname(fileURLToPath(import.meta.url));
const NODE_LOADER = join(here, "bao-env-loader.mjs");
const PY_LOADER = join(here, "bao-env-loader.py");

function findPython(): string | undefined {
  for (const candidate of ["python3", "python"]) {
    const res = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (res.status === 0 && /Python 3/.test(`${res.stdout}${res.stderr}`)) {
      return candidate;
    }
  }
  return undefined;
}

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
const python = findPython();

interface FakeBao {
  loginStatus: number;
  kvStatus: number;
  kvData: Record<string, unknown>;
  transientFailures: number;
  // Answer the login or the KV read with a redirect to another path.
  redirect: "none" | "login" | "kv";
  // Answer the KV read with 200 and a body that isn't JSON.
  kvMalformed: boolean;
  calls: string[];
}

const bao: FakeBao = {
  loginStatus: 200,
  kvStatus: 200,
  kvData: {},
  transientFailures: 0,
  redirect: "none",
  kvMalformed: false,
  calls: [],
};

let server: Server;
let baseUrl = "";
let certDir = "";
let certPath = "";

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  if (!hasOpenssl) return;
  certDir = mkdtempSync(join(tmpdir(), "bao-loader-test-"));
  certPath = join(certDir, "cert.pem");
  const keyPath = join(certDir, "key.pem");
  const gen = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`);

  server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      const path = req.url ?? "";
      bao.calls.push(path);
      const redirectHere =
        (bao.redirect === "login" && path.endsWith("/auth/approle/login")) ||
        (bao.redirect === "kv" && path.includes("/secret/data/"));
      if (redirectHere) {
        res.writeHead(307, { location: "/v1/elsewhere" });
        return res.end();
      }
      if (bao.kvMalformed && path.includes("/secret/data/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("this is not json");
      }
      if (bao.transientFailures > 0 && path.endsWith("/auth/approle/login")) {
        bao.transientFailures--;
        return send(res, 503, { errors: ["Vault is sealed"] });
      }
      if (path.endsWith("/auth/approle/login")) {
        return bao.loginStatus === 200
          ? send(res, 200, {
              auth: { client_token: "tok", lease_duration: 60 },
            })
          : send(res, bao.loginStatus, {
              errors: ["invalid role or secret ID"],
            });
      }
      if (path.includes("/secret/data/")) {
        return bao.kvStatus === 200
          ? send(res, 200, { data: { data: bao.kvData } })
          : send(res, bao.kvStatus, { errors: ["permission denied"] });
      }
      if (path.endsWith("/auth/token/revoke-self")) {
        res.writeHead(204);
        return res.end();
      }
      return send(res, 404, { errors: ["not found"] });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

beforeEach(() => {
  bao.loginStatus = 200;
  bao.kvStatus = 200;
  bao.kvData = {
    DATABASE_URL: "postgres://u:REAL-SECRET@db/x",
    API_KEY: "REAL-KEY",
  };
  bao.transientFailures = 0;
  bao.redirect = "none";
  bao.kvMalformed = false;
  bao.calls = [];
});

interface Run {
  code: number | null;
  loaderLog: string;
  childEnv: Record<string, string | null>;
}

// The child prints the keys it can see, so the test can assert what reached it.
const CHILD_KEYS = [
  "DATABASE_URL",
  "API_KEY",
  "REDIS_URL",
  "OPENBAO_ROLE_ID",
  "OPENBAO_SECRET_ID",
];
const CHILD = [
  process.execPath,
  "-e",
  `console.log("CHILD_ENV=" + JSON.stringify(Object.fromEntries(${JSON.stringify(CHILD_KEYS)}.map((k) => [k, process.env[k] ?? null]))))`,
];

const LOADERS = [
  {
    name: "node loader",
    cmd: process.execPath,
    script: NODE_LOADER,
    ca: "NODE_EXTRA_CA_CERTS",
    available: true,
  },
  {
    name: "python loader",
    cmd: python ?? "python3",
    script: PY_LOADER,
    ca: "BAO_CACERT",
    available: python !== undefined,
  },
];

describe.each(LOADERS)("$name", (loader) => {
  const enabled = hasOpenssl && loader.available;

  function run(extraEnv: Record<string, string> = {}): Promise<Run> {
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
      OPENBAO_ADDR: baseUrl,
      OPENBAO_ROLE_ID: "role-id",
      OPENBAO_SECRET_ID: "secret-id",
      BAO_KV_PATH: "openwind/test/backend",
      BAO_FAIL_SLEEP_SECONDS: "0",
      BAO_WAIT_SECONDS: "10",
      [loader.ca]: certPath,
      ...extraEnv,
    };
    return new Promise((resolve) => {
      const proc = spawn(loader.cmd, [loader.script, ...CHILD], { env });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("close", (code) => {
        const line = stdout
          .split(/\r?\n/)
          .find((l) => l.startsWith("CHILD_ENV="));
        resolve({
          code,
          loaderLog: stderr,
          childEnv: line
            ? (JSON.parse(line.slice("CHILD_ENV=".length)) as Record<
                string,
                string | null
              >)
            : {},
        });
      });
    });
  }

  it.skipIf(!enabled)(
    "starts the app with the OpenBao values and without the login",
    async () => {
      const r = await run();
      expect(r.code).toBe(0);
      expect(r.childEnv["DATABASE_URL"]).toBe("postgres://u:REAL-SECRET@db/x");
      expect(r.childEnv["API_KEY"]).toBe("REAL-KEY");
      expect(r.childEnv["OPENBAO_ROLE_ID"]).toBeNull();
      expect(r.childEnv["OPENBAO_SECRET_ID"]).toBeNull();
      expect(bao.calls.some((c) => c.endsWith("/auth/token/revoke-self"))).toBe(
        true,
      );
    },
  );

  it.skipIf(!enabled)("never prints a value", async () => {
    const r = await run();
    expect(r.loaderLog).not.toContain("REAL-SECRET");
    expect(r.loaderLog).not.toContain("REAL-KEY");
    expect(r.loaderLog).not.toContain("secret-id");
    expect(r.loaderLog).toContain("applied 2 keys");
  });

  it.skipIf(!enabled)(
    "passes the login on only when BAO_KEEP_LOGIN=1",
    async () => {
      const r = await run({ BAO_KEEP_LOGIN: "1" });
      expect(r.code).toBe(0);
      expect(r.childEnv["OPENBAO_ROLE_ID"]).toBe("role-id");
      expect(r.childEnv["OPENBAO_SECRET_ID"]).toBe("secret-id");
    },
  );

  it.skipIf(!enabled)(
    "keeps allowed compose wiring that OpenBao doesn't set",
    async () => {
      const r = await run({ REDIS_URL: "redis://redis:6379" });
      expect(r.code).toBe(0);
      expect(r.childEnv["REDIS_URL"]).toBe("redis://redis:6379");
    },
  );

  it.skipIf(!enabled)(
    "refuses to start when compose also sets an OpenBao key",
    async () => {
      const r = await run({ DATABASE_URL: "postgres://u:dev_password@db/x" });
      expect(r.code).toBe(78);
      expect(r.loaderLog).toContain("DATABASE_URL");
      expect(r.loaderLog).not.toContain("dev_password");
      expect(r.childEnv).toEqual({});
    },
  );

  it.skipIf(!enabled)(
    "lets OpenBao replace an empty compose value",
    async () => {
      const r = await run({ DATABASE_URL: "" });
      expect(r.code).toBe(0);
      expect(r.childEnv["DATABASE_URL"]).toBe("postgres://u:REAL-SECRET@db/x");
    },
  );

  it.skipIf(!enabled)(
    "exits 77 and never starts the app when the login is refused",
    async () => {
      bao.loginStatus = 400;
      const r = await run();
      expect(r.code).toBe(77);
      expect(r.childEnv).toEqual({});
      expect(
        bao.calls.filter((c) => c.endsWith("/auth/approle/login")),
      ).toHaveLength(1);
    },
  );

  it.skipIf(!enabled)("exits 77 when the KV read is refused", async () => {
    bao.kvStatus = 403;
    const r = await run();
    expect(r.code).toBe(77);
    expect(r.childEnv).toEqual({});
  });

  it.skipIf(!enabled)("exits 78 when a required key is missing", async () => {
    const r = await run({ BAO_REQUIRED_KEYS: "DATABASE_URL,MISSING_KEY" });
    expect(r.code).toBe(78);
    expect(r.loaderLog).toContain("MISSING_KEY");
    expect(r.childEnv).toEqual({});
  });

  it.skipIf(!enabled)(
    "waits while OpenBao is sealed, then starts",
    async () => {
      bao.transientFailures = 2;
      const r = await run();
      expect(r.code).toBe(0);
      expect(
        bao.calls.filter((c) => c.endsWith("/auth/approle/login")),
      ).toHaveLength(3);
    },
  );

  it.skipIf(!enabled)(
    "never follows a redirect on the login (credentials not re-sent)",
    async () => {
      bao.redirect = "login";
      const r = await run();
      expect(r.code).toBe(77);
      expect(r.childEnv).toEqual({});
      expect(bao.calls.some((c) => c.endsWith("/v1/elsewhere"))).toBe(false);
    },
  );

  it.skipIf(!enabled)(
    "never follows a redirect on the KV read (token not re-sent), and revokes the token",
    async () => {
      bao.redirect = "kv";
      const r = await run();
      expect(r.code).toBe(77);
      expect(bao.calls.some((c) => c.endsWith("/v1/elsewhere"))).toBe(false);
      expect(bao.calls.some((c) => c.endsWith("/auth/token/revoke-self"))).toBe(
        true,
      );
    },
  );

  it.skipIf(!enabled)(
    "revokes the token when the KV read keeps failing until the wait runs out",
    async () => {
      bao.kvStatus = 503;
      const r = await run({ BAO_WAIT_SECONDS: "1" });
      expect(r.code).toBe(69);
      expect(bao.calls.some((c) => c.endsWith("/auth/token/revoke-self"))).toBe(
        true,
      );
    },
  );

  it.skipIf(!enabled)(
    "treats a malformed KV reply as a refusal (normal exit code, no crash)",
    async () => {
      bao.kvMalformed = true;
      const r = await run();
      expect(r.code).toBe(77);
      expect(r.loaderLog).not.toMatch(/Traceback/);
      expect(r.childEnv).toEqual({});
    },
  );

  it.skipIf(!enabled)("exits 69 when OpenBao stays unreachable", async () => {
    const r = await run({
      OPENBAO_ADDR: "https://127.0.0.1:1",
      BAO_WAIT_SECONDS: "1",
    });
    expect(r.code).toBe(69);
    expect(r.childEnv).toEqual({});
  });

  it.skipIf(!enabled)("refuses plain http", async () => {
    const r = await run({
      OPENBAO_ADDR: baseUrl.replace("https://", "http://"),
    });
    expect(r.code).toBe(78);
    expect(bao.calls).toHaveLength(0);
  });

  it.skipIf(!enabled)(
    "sends no credentials when the server is outside OPENBAO_NETWORK_CIDR",
    async () => {
      const r = await run({ OPENBAO_NETWORK_CIDR: "10.0.0.0/8" });
      expect(r.code).toBe(78);
      expect(bao.calls).toHaveLength(0);
    },
  );

  it.skipIf(!enabled)(
    "proceeds when the server is inside OPENBAO_NETWORK_CIDR",
    async () => {
      const r = await run({ OPENBAO_NETWORK_CIDR: "127.0.0.0/8" });
      expect(r.code).toBe(0);
    },
  );

  it.skipIf(!enabled)("exits 78 when a setting is missing", async () => {
    const r = await run({ BAO_KV_PATH: "" });
    expect(r.code).toBe(78);
    expect(bao.calls).toHaveLength(0);
  });
});
