// OpenBao startup loader (ADR-023 Decision 2). Runs as a container entrypoint:
//
//   node bao-env-loader.mjs <original command...>
//
// It logs in with AppRole, reads ONE KV v2 path, revokes its own token, checks
// the required keys, and starts the original command with those values added
// to its environment. It fails closed: if OpenBao can't be reached, refuses the
// login or the read, or a required key is missing, the app is never started.
// It never prints a value, only key names and counts.
//
// Settings (all from the container environment):
//   OPENBAO_ADDR            https:// URL of the server (plain http is refused)
//   OPENBAO_ROLE_ID         AppRole role ID
//   OPENBAO_SECRET_ID       AppRole secret ID
//   BAO_KV_PATH             path under the `secret/` KV v2 mount, e.g. openwind/prod/backend
//   BAO_REQUIRED_KEYS       optional comma list of keys that must be present and non-empty
//   BAO_KEEP_LOGIN          "1" to pass the role ID and secret ID on to the app
//                           (backend and worker, which call Transit at runtime)
//   OPENBAO_NETWORK_CIDR    optional IPv4 CIDR; credentials are only sent if the
//                           server name resolves inside it (the per-project network)
//   BAO_WAIT_SECONDS        how long to keep retrying while OpenBao is unreachable
//                           or sealed (default 120)
//   BAO_FAIL_SLEEP_SECONDS  pause before exiting on a refused login/read or a
//                           config error, so `restart: unless-stopped` can't turn
//                           it into a tight login loop (default 30)
//
// Exit codes: 69 unreachable or sealed, 77 refused (including any HTTP redirect, which is
// never followed), 78 configuration or missing/conflicting key. Otherwise the app's own
// exit code. The login token is revoked after the read, and also when the read fails.
//
// Precedence: OpenBao values win. A key that compose also sets to a non-empty
// value is a conflict and the loader refuses to start, so a compose default can
// never silently replace a real secret. An empty compose value is overridden.
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

const TAG = "[bao-env]";
const REQUEST_TIMEOUT_MS = 15_000;
const EXIT_UNREACHABLE = 69;
const EXIT_REFUSED = 77;
const EXIT_CONFIG = 78;

function log(message) {
  console.error(`${TAG} ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const failSleepMs = numberSetting("BAO_FAIL_SLEEP_SECONDS", 30) * 1000;
const waitMs = numberSetting("BAO_WAIT_SECONDS", 120) * 1000;

class Fatal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Throws instead of calling process.exit(): exiting while an HTTPS connection
// is still open can abort the process with a crash code instead of ours.
function fail(code, message) {
  throw new Fatal(code, message);
}

function need(name) {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : undefined;
}

function ipv4ToInt(ip) {
  return (
    ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  );
}

function inCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (!isIPv4(ip) || !base || !isIPv4(base) || !(bits >= 0 && bits <= 32)) {
    return false;
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// Network errors, 429 and 5xx (503 while sealed) are worth waiting for;
// any other status is a definite answer.
function isTransient(status) {
  return status === 429 || status >= 500;
}

async function call(addr, method, path, body, token) {
  const res = await fetch(`${addr}/v1/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-vault-token": token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // A followed redirect would resend the AppRole login or the token to a host the
    // OPENBAO_NETWORK_CIDR check never saw. OpenBao doesn't redirect, so a 3xx is refused below.
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body: the status code alone decides.
  }
  return { status: res.status, json };
}

// Retries transient failures until BAO_WAIT_SECONDS has passed.
async function callWithWait(addr, method, path, body, token, deadline) {
  let delay = 1_000;
  for (;;) {
    let result;
    try {
      result = await call(addr, method, path, body, token);
    } catch (err) {
      result = { status: 0, error: err };
    }
    if (result.status >= 300 && result.status < 400) {
      return fail(
        EXIT_REFUSED,
        `OpenBao answered HTTP ${result.status} (a redirect) at ${addr}; refusing to follow it`,
      );
    }
    if (result.status !== 0 && !isTransient(result.status)) return result;
    if (Date.now() + delay > deadline) {
      const reason =
        result.status === 0
          ? `unreachable (${result.error?.cause?.code ?? result.error?.name ?? "error"})`
          : `HTTP ${result.status}`;
      return fail(
        EXIT_UNREACHABLE,
        `OpenBao ${reason} at ${addr}; gave up after ${Math.round(waitMs / 1000)}s`,
      );
    }
    log(
      `OpenBao not ready (${result.status === 0 ? "unreachable" : `HTTP ${result.status}`}); retrying`,
    );
    await sleep(delay);
    delay = Math.min(delay * 2, 10_000);
  }
}

async function checkServerAddress(addr, cidr) {
  const host = new URL(addr).hostname;
  let addresses;
  try {
    addresses = isIPv4(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
  } catch (err) {
    return fail(
      EXIT_CONFIG,
      `cannot resolve ${host} (${err.code ?? err.message})`,
    );
  }
  const outside = addresses.filter((a) => !inCidr(a.address, cidr));
  if (addresses.length === 0 || outside.length > 0) {
    return fail(
      EXIT_CONFIG,
      `${host} does not resolve inside OPENBAO_NETWORK_CIDR ${cidr}; refusing to send credentials (is this container on the OpenBao network?)`,
    );
  }
}

async function main() {
  const addr = need("OPENBAO_ADDR")?.replace(/\/+$/, "");
  const roleId = need("OPENBAO_ROLE_ID");
  const secretId = need("OPENBAO_SECRET_ID");
  const kvPath = need("BAO_KV_PATH");
  const cidr = need("OPENBAO_NETWORK_CIDR");
  const required = (process.env.BAO_REQUIRED_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const argv = process.argv.slice(2);

  for (const [name, value] of [
    ["OPENBAO_ADDR", addr],
    ["OPENBAO_ROLE_ID", roleId],
    ["OPENBAO_SECRET_ID", secretId],
    ["BAO_KV_PATH", kvPath],
  ]) {
    if (!value) return fail(EXIT_CONFIG, `${name} is not set`);
  }
  if (argv.length === 0) return fail(EXIT_CONFIG, "no command to run");
  if (!addr.startsWith("https://")) {
    return fail(EXIT_CONFIG, "OPENBAO_ADDR must use https://");
  }
  if (cidr) await checkServerAddress(addr, cidr);

  const deadline = Date.now() + waitMs;
  const login = await callWithWait(
    addr,
    "POST",
    "auth/approle/login",
    { role_id: roleId, secret_id: secretId },
    undefined,
    deadline,
  );
  const token = login.json?.auth?.client_token;
  if (login.status !== 200 || !token) {
    return fail(EXIT_REFUSED, `AppRole login refused (HTTP ${login.status})`);
  }

  let kv;
  try {
    kv = await callWithWait(
      addr,
      "GET",
      `secret/data/${kvPath}`,
      undefined,
      token,
      deadline,
    );
  } finally {
    // The token was only needed for this one read. Revoke it even when the read fails or
    // gives up, so a restart loop doesn't leave live tokens behind; best effort.
    await call(addr, "POST", "auth/token/revoke-self", {}, token).catch(
      () => {},
    );
  }

  const data = kv.json?.data?.data;
  if (kv.status !== 200 || !data || typeof data !== "object") {
    return fail(
      EXIT_REFUSED,
      `cannot read secret/${kvPath} (HTTP ${kv.status})`,
    );
  }

  const missing = required.filter(
    (key) => data[key] === undefined || data[key] === null || data[key] === "",
  );
  if (missing.length > 0) {
    return fail(
      EXIT_CONFIG,
      `required keys missing in secret/${kvPath}: ${missing.join(", ")}`,
    );
  }

  const conflicts = Object.keys(data).filter((key) => {
    const composeValue = process.env[key];
    return composeValue !== undefined && composeValue.trim() !== "";
  });
  if (conflicts.length > 0) {
    return fail(
      EXIT_CONFIG,
      `keys set both by compose and in secret/${kvPath}: ${conflicts.sort().join(", ")} (remove them from compose; OpenBao is the source)`,
    );
  }

  const env = { ...process.env };
  for (const [key, value] of Object.entries(data)) {
    env[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  if (process.env.BAO_KEEP_LOGIN !== "1") {
    delete env.OPENBAO_ROLE_ID;
    delete env.OPENBAO_SECRET_ID;
  }
  log(
    `applied ${Object.keys(data).length} keys from secret/${kvPath}${process.env.BAO_KEEP_LOGIN === "1" ? "; login passed on" : ""} (values never logged)`,
  );

  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (err) => {
    log(`FATAL: cannot start ${argv[0]} (${err.code ?? err.message})`);
    process.exitCode = EXIT_CONFIG;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

try {
  await main();
} catch (err) {
  const code = err instanceof Fatal ? err.code : EXIT_CONFIG;
  log(
    `FATAL: ${err instanceof Fatal ? err.message : `unexpected error (${err?.name ?? "error"})`}`,
  );
  // Unreachable already waited for BAO_WAIT_SECONDS; everything else pauses
  // here so a restart policy can't hammer OpenBao with failed logins.
  if (code !== EXIT_UNREACHABLE && failSleepMs > 0) await sleep(failSleepMs);
  process.exitCode = code;
}
