#!/usr/bin/env tsx
/**
 * bootstrap.ts — one-command developer setup for OpenWind
 *
 * Steps:
 *   1.  Preflight — node / pnpm / docker version checks
 *   2.  Environment — copy .env.example → .env.local (if missing)
 *   3.  Infrastructure — docker compose up -d
 *   4.  Health — wait for Postgres, Zitadel, and OpenBao
 *   5.  Dependencies — pnpm install
 *   6.  Database — migrate + base seed
 *   7.  Auth — Zitadel project, OIDC app, roles  (one manual PAT step)
 *   8.  Demo users — admin@openwind.local + user@openwind.local
 *   9.  Templates — seed module registry so all templates appear on the Templates page
 *  10.  Summary — all URLs and credentials printed
 *
 * Run:
 *   pnpm bootstrap
 *   # or directly:
 *   npx tsx scripts/bootstrap.ts
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";
import { request as nodeHttpRequest } from "node:http";

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env.local");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const IN_DOCKER = process.env["RUNNING_IN_DOCKER"] === "true";
const _ZITADEL_EXTERNAL_DOMAIN =
  process.env["ZITADEL_EXTERNAL_DOMAIN"] ?? "localhost";
const _ZITADEL_HOST_PORT = process.env["ZITADEL_HOST_PORT"] ?? "8080";
// ZITADEL_BASE is used for API calls from within the bootstrap container.
// When IN_DOCKER, always connect via Docker service name (zitadel:8080) regardless
// of the external domain — the httpPost/httpGet helpers set the Host header separately
// so Zitadel's instance routing still works. This avoids routing through the public
// internet when ExternalDomain is a real hostname (e.g. owzitadel.rokkalabs.com).
const ZITADEL_BASE =
  process.env["ZITADEL_BOOTSTRAP_URL"] ??
  (IN_DOCKER
    ? "http://zitadel:8080"
    : `http://localhost:${_ZITADEL_HOST_PORT}`);
// Health check always uses the internal container address — no Host header
// routing needed, and it works regardless of EXTERNALSECURE setting.
const ZITADEL_HEALTH_URL = IN_DOCKER
  ? "http://zitadel:8080"
  : `http://localhost:${_ZITADEL_HOST_PORT}`;
// Browser-accessible URL — shown in PAT instructions and final summary.
// When EXTERNALSECURE=true the subdomain is served over HTTPS by a reverse proxy
// on the standard port (443) — no port suffix needed.
const _ZITADEL_EXTERNAL_SECURE =
  process.env["ZITADEL_EXTERNALSECURE"] === "true";
const ZITADEL_BROWSER_URL =
  _ZITADEL_EXTERNAL_DOMAIN !== "localhost"
    ? _ZITADEL_EXTERNAL_SECURE
      ? `https://${_ZITADEL_EXTERNAL_DOMAIN}`
      : `http://${_ZITADEL_EXTERNAL_DOMAIN}:${_ZITADEL_HOST_PORT}`
    : `http://localhost:${_ZITADEL_HOST_PORT}`;
const TOTAL_STEPS = 10;

// Demo credentials (printed in summary, committed to docs — dev only)
const DEMO_ADMIN_EMAIL = "owAdmin@openwind.local";
const DEMO_USER_EMAIL = "owUser@openwind.local";
const DEMO_PASSWORD = "OpenWind1234!";

// ── Formatting ────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function step(n: number, msg: string): void {
  console.log(
    `\n${BOLD}${CYAN}[${n}/${TOTAL_STEPS}]${RESET} ${BOLD}${msg}${RESET}`,
  );
}

function ok(msg: string): void {
  console.log(`  ${GREEN}✓${RESET}  ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}⚠${RESET}  ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${DIM}→${RESET}  ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  ${RED}✗${RESET}  ${BOLD}${msg}${RESET}\n`);
  process.exit(1);
}

function banner(): void {
  console.log(`
${BOLD}${CYAN}  ___                 _    _ _         _   ${RESET}
${BOLD}${CYAN} / _ \\ _ __  ___ _ _| |  | | |_ _ __ __| |  ${RESET}
${BOLD}${CYAN}| (_) | '_ \\/ -_) ' \\ |/\\| | | ' \\/ _\` |  ${RESET}
${BOLD}${CYAN} \\___/| .__/\\___|_||_\\_/  \\_|_|_||_\\__,_|  ${RESET}
${BOLD}${CYAN}      |_|                                   ${RESET}

  ${BOLD}Developer Bootstrap${RESET} — one command to a fully running system
  ${DIM}This will take 2–5 minutes on first run.${RESET}
`);
}

// ── Shell helpers ─────────────────────────────────────────────────────────────

function run(
  cmd: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(cmd, {
    shell: true,
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
  });
  if ((result.status ?? 1) !== 0) {
    fail(`Command failed: ${cmd}`);
  }
}

function runCapture(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Service health polling ────────────────────────────────────────────────────

async function waitForHttp(
  url: string,
  label: string,
  maxAttempts = 60,
  intervalMs = 3000,
): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.status < 500) {
        ok(`${label} is ready`);
        return;
      }
    } catch {
      // not ready yet — suppress
    }
    if (i % 5 === 0) {
      info(
        `Still waiting for ${label}… (${Math.round((i * intervalMs) / 1000)}s)`,
      );
    }
    await sleep(intervalMs);
  }
  fail(
    `${label} did not become healthy after ${Math.round((maxAttempts * intervalMs) / 1000)}s.\nCheck logs: docker compose logs ${label.toLowerCase()}`,
  );
}

async function waitForPostgres(
  maxAttempts = 30,
  intervalMs = 3000,
): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    const out = runCapture(
      `docker compose exec -T postgres pg_isready -U platform -d platform`,
    );
    if (out.includes("accepting connections")) {
      ok("Postgres is ready");
      return;
    }
    if (i % 5 === 0)
      info(
        `Still waiting for Postgres… (${Math.round((i * intervalMs) / 1000)}s)`,
      );
    await sleep(intervalMs);
  }
  fail("Postgres did not become ready. Check: docker compose logs postgres");
}

// ── .env.local helpers ────────────────────────────────────────────────────────

function readEnvLocal(): Map<string, string> {
  if (!existsSync(ENV_FILE)) return new Map();
  return new Map(
    readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
      .map((l) => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as [
          string,
          string,
        ];
      }),
  );
}

function writeEnvVars(vars: Record<string, string>): void {
  const existing = readEnvLocal();
  for (const [k, v] of Object.entries(vars)) {
    if (!v.startsWith("<existing")) existing.set(k, v);
  }
  const header = [
    "# Generated / managed by scripts/bootstrap.ts",
    `# Last updated: ${new Date().toISOString()}`,
    "",
  ].join("\n");
  const body = [...existing.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(ENV_FILE, `${header}${body}\n`, "utf8");
}

// ── Zitadel API helper ────────────────────────────────────────────────────────
// Node.js fetch treats `Host` as a forbidden header and ignores it — the URL
// hostname always becomes the Host header. We use node:http directly so we can
// connect to http://zitadel:8080 (internal Docker name) while sending
// Host: localhost (the EXTERNALDOMAIN Zitadel's instance is registered for).

function httpPost(
  url: string,
  hostOverride: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyBuf = Buffer.from(body);
    const req = nodeHttpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          ...headers,
          Host: hostOverride,
          "Content-Length": bodyBuf.length.toString(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data }),
        );
      },
    );
    req.setTimeout(15_000, () => {
      req.destroy(new Error("Zitadel API request timed out"));
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

function httpGet(
  url: string,
  hostOverride: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = nodeHttpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : 80,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { ...headers, Host: hostOverride },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data }),
        );
      },
    );
    req.setTimeout(15_000, () => {
      req.destroy(new Error("Zitadel API request timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function zCall(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const method = options.method ?? "GET";
  const commonHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  let result: { status: number; text: string };
  if (method === "GET") {
    result = await httpGet(
      `${ZITADEL_BASE}${path}`,
      _ZITADEL_EXTERNAL_DOMAIN,
      commonHeaders,
    );
  } else {
    result = await httpPost(
      `${ZITADEL_BASE}${path}`,
      _ZITADEL_EXTERNAL_DOMAIN,
      commonHeaders,
      options.body !== undefined ? JSON.stringify(options.body) : "",
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${method} ${path} → ${result.status}: ${result.text}`);
  }
  return JSON.parse(result.text) as unknown;
}

// ── JWT Profile Grant (authNexus pattern) ────────────────────────────────────
// Once ZITADEL_KEY_JSON is in .env.local, bootstrap is fully headless — no PAT.

interface ZitadelKeyJson {
  type: string;
  keyId: string;
  key: string; // RSA private key PEM
  userId: string;
}

function signJwt(
  payload: Record<string, unknown>,
  privateKeyPem: string,
  keyId: string,
): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64url({ alg: "RS256", typ: "JWT", kid: keyId });
  const body = b64url(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(privateKeyPem, "base64url")}`;
}

async function discoverIssuer(): Promise<string> {
  // Hit the OIDC discovery endpoint to get the exact issuer URL Zitadel expects
  // as the JWT audience — avoids port mismatch between internal (8080) and external (443).
  try {
    const res = await httpGet(
      `${ZITADEL_BASE}/.well-known/openid-configuration`,
      _ZITADEL_EXTERNAL_DOMAIN,
      {},
    );
    if (res.status === 200) {
      const data = JSON.parse(res.text) as { issuer: string };
      if (data.issuer) return data.issuer;
    }
  } catch {
    // fall back to ZITADEL_BASE
  }
  return ZITADEL_BASE;
}

async function getTokenFromKeyJson(keyJson: ZitadelKeyJson): Promise<string> {
  const issuer = await discoverIssuer();
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(
    {
      iss: keyJson.userId,
      sub: keyJson.userId,
      aud: [issuer],
      iat: now,
      exp: now + 60,
    },
    keyJson.key,
    keyJson.keyId,
  );
  const result = await httpPost(
    `${ZITADEL_BASE}/oauth/v2/token`,
    _ZITADEL_EXTERNAL_DOMAIN,
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      scope: "openid urn:zitadel:iam:org:project:id:zitadel:aud",
      assertion: jwt,
    }).toString(),
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `JWT token exchange failed ${result.status}: ${result.text}`,
    );
  }
  const data = JSON.parse(result.text) as { access_token: string };
  return data.access_token;
}

function readKeyJsonFromEnv(): ZitadelKeyJson | null {
  const raw = readEnvLocal().get("ZITADEL_KEY_JSON");
  if (!raw) return null;
  try {
    return JSON.parse(
      Buffer.from(raw, "base64").toString("utf8"),
    ) as ZitadelKeyJson;
  } catch {
    return null;
  }
}

async function generateAndSaveKeyJson(token: string): Promise<void> {
  const search = (await zCall("/management/v1/users/_search", token, {
    method: "POST",
    body: {
      queries: [
        {
          userNameQuery: {
            userName: "openwind-api-bot",
            method: "TEXT_QUERY_METHOD_EQUALS",
          },
        },
      ],
    },
  })) as { result?: Array<{ id: string }> };

  const userId = search.result?.[0]?.id;
  if (!userId) {
    warn(
      "Could not find openwind-api-bot machine user — skipping key JSON generation",
    );
    return;
  }

  const keyRes = (await zCall(`/management/v1/users/${userId}/keys`, token, {
    method: "POST",
    body: { type: "KEY_TYPE_JSON", expirationDate: "2035-01-01T00:00:00Z" },
  })) as { keyId: string; keyDetails: string };

  // keyDetails is base64-encoded JSON — re-encode the raw JSON for our env var
  const keyJsonStr = Buffer.from(keyRes.keyDetails, "base64").toString("utf8");
  writeEnvVars({
    ZITADEL_KEY_JSON: Buffer.from(keyJsonStr).toString("base64"),
    // ZITADEL_SERVICE_ACCOUNT_KEY is the raw JSON string read by the API server
    // (zitadel-management.ts) for live user/role queries at runtime.
    ZITADEL_SERVICE_ACCOUNT_KEY: keyJsonStr,
  });
  ok("ZITADEL_KEY_JSON + ZITADEL_SERVICE_ACCOUNT_KEY saved to .env.local");
}

async function getAdminToken(): Promise<string> {
  // Fast path — saved key from a previous run (stored in .env.local after first setup)
  const keyJson = readKeyJsonFromEnv();
  if (keyJson) {
    try {
      const token = await getTokenFromKeyJson(keyJson);
      ok("Authenticated via saved JWT key — fully headless");
      return token;
    } catch (e) {
      warn(`Saved key auth failed (${String(e)}) — clearing stale key`);
      writeEnvVars({ ZITADEL_KEY_JSON: "" });
    }
  }

  // First-run path — PAT generated by `zitadel/setup.bat` (ow-zita-setup container)
  // and passed in via ZITADEL_SETUP_PAT env var when running `openwind/setup.bat --pat <token>`.
  const setupPat = process.env["ZITADEL_SETUP_PAT"]?.trim();
  if (setupPat && setupPat.length > 20) {
    ok(
      "Using PAT from ZITADEL_SETUP_PAT — generating key JSON for future headless runs...",
    );
    try {
      await generateAndSaveKeyJson(setupPat);
    } catch (e) {
      warn(
        `Could not save key JSON (${String(e)}) — this run will succeed but next run may need a new PAT`,
      );
    }
    return setupPat;
  }

  fail(`No Zitadel credentials found.

  Run the Zitadel setup first to generate a PAT:

    ${CYAN}cd zitadel${RESET}
    ${CYAN}setup.bat${RESET}          (Windows)
    ${CYAN}./setup.sh${RESET}         (Linux / Mac)

  Then re-run OpenWind setup with the printed PAT:

    ${CYAN}setup.bat --pat <token>${RESET}    (Windows)
    ${CYAN}./setup.sh --pat <token>${RESET}   (Linux / Mac)
`);
}

// ── Zitadel setup (mirrors setup-dev-auth.ts but returns projectId) ───────────

async function runZitadelSetup(
  pat: string,
): Promise<{ projectId: string; oidcClientId: string }> {
  const PROJECT_NAME = "OpenWind";
  const APP_NAME = "openwind-api";
  const SA_NAME = "platform-introspection";
  const TOKEN_EXPIRY = 15 * 60;

  // 1. Project
  const searchRes = (await zCall("/management/v1/projects/_search", pat, {
    method: "POST",
    body: {
      queries: [
        {
          nameQuery: { name: PROJECT_NAME, method: "TEXT_QUERY_METHOD_EQUALS" },
        },
      ],
    },
  })) as { result?: Array<{ id: string; name: string }> };

  let projectId =
    searchRes.result?.find((p) => p.name === PROJECT_NAME)?.id ?? null;

  if (projectId) {
    ok(`Project "${PROJECT_NAME}" already exists`);
    // Ensure projectRoleAssertion is enabled — roles won't appear in JWT without it
    try {
      await zCall(`/management/v1/projects/${projectId}`, pat, {
        method: "PUT",
        body: {
          name: PROJECT_NAME,
          projectRoleAssertion: true,
          projectRoleCheck: false,
          hasProjectCheck: false,
        },
      });
    } catch {
      /* best effort */
    }
  } else {
    const created = (await zCall("/management/v1/projects", pat, {
      method: "POST",
      body: {
        name: PROJECT_NAME,
        projectRoleAssertion: true,
        projectRoleCheck: false,
        hasProjectCheck: false,
      },
    })) as { id: string };
    projectId = created.id;
    ok(`Created project "${PROJECT_NAME}"`);
  }

  // 2. Roles: admin, agent, user
  for (const role of ["admin", "agent", "user"]) {
    try {
      await zCall(`/management/v1/projects/${projectId}/roles`, pat, {
        method: "POST",
        body: {
          roleKey: role,
          displayName: role.charAt(0).toUpperCase() + role.slice(1),
          group: "platform",
        },
      });
      ok(`Created role "${role}"`);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("409") || msg.toLowerCase().includes("already exist")) {
        ok(`Role "${role}" already exists`);
      } else {
        warn(`Could not create role "${role}": ${msg}`);
      }
    }
  }

  // 3. OIDC app
  const appSearch = (await zCall(
    `/management/v1/projects/${projectId}/apps/_search`,
    pat,
    {
      method: "POST",
      body: {
        queries: [
          { nameQuery: { name: APP_NAME, method: "TEXT_QUERY_METHOD_EQUALS" } },
        ],
      },
    },
  )) as {
    result?: Array<{
      id: string;
      name: string;
      oidcConfig?: { clientId: string };
    }>;
  };

  const existingApp = appSearch.result?.find((a) => a.name === APP_NAME);
  let oidcClientId: string;
  let oidcClientSecret: string;

  // Include APP_URL / CORS_ORIGIN in redirect URIs when set.
  // APP_URL is the new base var; CORS_ORIGIN is the legacy alias — check both.
  const corsOrigin = process.env["APP_URL"] ?? process.env["CORS_ORIGIN"];
  const extraOrigins: string[] = corsOrigin ? [corsOrigin] : [];
  const oidcPayload = {
    redirectUris: [
      "http://localhost:3001/auth/callback",
      "http://localhost:3000/auth/callback",
      ...extraOrigins.map((o) => `${o}/auth/callback`),
    ],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: [
      "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
      "OIDC_GRANT_TYPE_REFRESH_TOKEN",
    ],
    appType: "OIDC_APP_TYPE_WEB",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
    postLogoutRedirectUris: [
      "http://localhost:3001",
      "http://localhost:3001/login",
      "http://localhost:3000",
      ...extraOrigins,
      ...extraOrigins.map((o) => `${o}/login`),
    ],
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    accessTokenRoleAssertion: true,
    idTokenRoleAssertion: true,
    idTokenUserinfoAssertion: true,
    accessTokenLifetime: `${TOKEN_EXPIRY}s`,
    idTokenLifetime: `${TOKEN_EXPIRY}s`,
  };

  if (existingApp?.oidcConfig?.clientId) {
    oidcClientId = existingApp.oidcConfig.clientId;
    oidcClientSecret = "<existing>";
    ok(`OIDC app "${APP_NAME}" already exists`);
    // Update config in case redirect URIs changed
    try {
      await zCall(
        `/management/v1/projects/${projectId}/apps/${existingApp.id}/oidc`,
        pat,
        {
          method: "PUT",
          body: oidcPayload,
        },
      );
    } catch {
      /* best effort */
    }
  } else {
    const created = (await zCall(
      `/management/v1/projects/${projectId}/apps/oidc`,
      pat,
      {
        method: "POST",
        body: { name: APP_NAME, ...oidcPayload },
      },
    )) as { appId: string; clientId: string; clientSecret: string };
    oidcClientId = created.clientId;
    oidcClientSecret = created.clientSecret;
    ok(`Created OIDC app "${APP_NAME}"`);
  }

  // 4. Introspection service account
  const saSearch = (await zCall("/management/v1/users/_search", pat, {
    method: "POST",
    body: {
      queries: [
        {
          userNameQuery: {
            userName: SA_NAME,
            method: "TEXT_QUERY_METHOD_EQUALS",
          },
        },
      ],
    },
  })) as { result?: Array<{ id: string }> };

  let saId = saSearch.result?.[0]?.id ?? null;
  if (!saId) {
    const sa = (await zCall("/management/v1/users/machine", pat, {
      method: "POST",
      body: {
        userName: SA_NAME,
        name: "OpenWind Introspection Service",
        description: "OpenWind service account for token introspection",
        accessTokenType: "ACCESS_TOKEN_TYPE_JWT",
      },
    })) as { userId: string };
    saId = sa.userId;
    ok(`Created introspection service account`);
  } else {
    ok("Introspection service account already exists");
  }

  // 5. Machine client credentials
  let introspectionClientId = saId;
  let introspectionClientSecret = "";
  try {
    const creds = (await zCall(`/management/v1/users/${saId}/secret`, pat, {
      method: "PUT",
      body: {},
    })) as { clientId: string; clientSecret: string };
    introspectionClientId = creds.clientId;
    introspectionClientSecret = creds.clientSecret;
  } catch {
    warn("Could not generate introspection credentials — using PAT fallback");
  }

  // 6. Grant admin role to root admin user
  const adminSearch = (await zCall("/management/v1/users/_search", pat, {
    method: "POST",
    body: {
      queries: [
        {
          userNameQuery: {
            userName: "owZitadelAdmin",
            method: "TEXT_QUERY_METHOD_EQUALS",
          },
        },
      ],
    },
  })) as { result?: Array<{ id: string }> };
  const rootAdminId = adminSearch.result?.[0]?.id;
  if (rootAdminId) {
    try {
      await zCall(`/management/v1/users/${rootAdminId}/grants`, pat, {
        method: "POST",
        body: { projectId, roleKeys: ["admin"] },
      });
      ok(`Granted "admin" role to owZitadelAdmin`);
    } catch (e) {
      if (
        !String(e).includes("409") &&
        !String(e).toLowerCase().includes("already exist")
      ) {
        warn(`Could not grant admin role to root admin: ${String(e)}`);
      } else {
        ok(`owZitadelAdmin already has "admin" role`);
      }
    }
  }

  // 7. Allow username-only login (no @domain suffix required)
  try {
    await zCall("/management/v1/policies/domain", pat, {
      method: "PUT",
      body: {
        userLoginMustBeDomain: false,
        validateOrgDomains: false,
        smtpSenderAddressMatchesInstanceDomain: false,
      },
    });
    ok(
      "Login policy updated — users can log in with username only (no @domain needed)",
    );
  } catch (e) {
    warn(`Could not update domain policy: ${String(e)}`);
  }

  // 8. Write env vars
  // ZITADEL_ISSUER must be the browser-accessible URL (localhost), not the
  // internal Docker name — the frontend calls this from the user's browser.
  // VITE_ prefixed copies are needed because Vite only exposes VITE_* vars
  // to import.meta.env in the dev server.
  writeEnvVars({
    // Base URL vars — set these and the derived vars below are optional.
    ZITADEL_URL: ZITADEL_BROWSER_URL,
    // Keep explicit derived vars so existing setups that read them directly still work.
    ZITADEL_ISSUER: ZITADEL_BROWSER_URL,
    ZITADEL_AUDIENCE: projectId,
    ZITADEL_INTROSPECTION_URL: `${ZITADEL_BROWSER_URL}/oauth/v2/introspect`,
    ZITADEL_INTROSPECTION_CLIENT_ID: introspectionClientId,
    ZITADEL_INTROSPECTION_CLIENT_SECRET: introspectionClientSecret,
    ZITADEL_OIDC_CLIENT_ID: oidcClientId,
    ZITADEL_OIDC_CLIENT_SECRET: oidcClientSecret,
    VITE_ZITADEL_ISSUER: ZITADEL_BROWSER_URL,
    VITE_ZITADEL_OIDC_CLIENT_ID: oidcClientId,
  });

  return { projectId, oidcClientId };
}

// ── Zitadel demo user creation ────────────────────────────────────────────────

async function createDemoUser(
  pat: string,
  projectId: string,
  opts: {
    email: string;
    firstName: string;
    lastName: string;
    userName: string;
    role: string;
  },
): Promise<void> {
  // Check if user already exists
  const search = (await zCall("/management/v1/users/_search", pat, {
    method: "POST",
    body: {
      queries: [
        {
          emailQuery: {
            emailAddress: opts.email,
            method: "TEXT_QUERY_METHOD_EQUALS",
          },
        },
      ],
    },
  })) as { result?: Array<{ id: string }> };

  let userId = search.result?.[0]?.id ?? null;

  if (!userId) {
    // Create the human user.
    // The Management API v1 proto field is `initial_password` (→ `initialPassword` in JSON),
    // NOT a nested `password` object. Using the correct field name creates the user in
    // ACTIVE state immediately — no init-code activation screen on first login.
    const created = (await zCall("/management/v1/users/human", pat, {
      method: "POST",
      body: {
        userName: opts.userName,
        profile: {
          firstName: opts.firstName,
          lastName: opts.lastName,
          displayName: `${opts.firstName} ${opts.lastName}`,
          preferredLanguage: "en",
        },
        email: {
          email: opts.email,
          isEmailVerified: true,
        },
        initialPassword: DEMO_PASSWORD,
      },
    })) as { userId: string };
    userId = created.userId;

    ok(`Created user ${opts.email}`);
  } else {
    ok(`User ${opts.email} already exists`);
  }

  // Grant project role
  try {
    await zCall(`/management/v1/users/${userId}/grants`, pat, {
      method: "POST",
      body: { projectId, roleKeys: [opts.role] },
    });
    ok(`  → granted role "${opts.role}"`);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("409") || msg.toLowerCase().includes("already exist")) {
      ok(`  → role "${opts.role}" already granted`);
    } else {
      warn(`  → could not grant role "${opts.role}": ${msg}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  // ── 1. Preflight ─────────────────────────────────────────────────────────────

  step(1, "Checking prerequisites");

  if (IN_DOCKER) {
    ok("Running inside Docker — skipping host prerequisite checks");
  } else {
    const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (nodeMajor < 22) {
      fail(
        `Node.js 22+ required. Current: v${process.versions.node}.\nDownload from https://nodejs.org`,
      );
    }
    ok(`Node.js v${process.versions.node}`);

    const pnpmVer = runCapture("pnpm --version");
    if (!pnpmVer) fail("pnpm not found. Install: npm install -g pnpm");
    ok(`pnpm ${pnpmVer}`);

    const dockerRunning = runCapture(
      "docker info --format '{{.ServerVersion}}'",
    );
    if (!dockerRunning)
      fail("Docker is not running. Start Docker Desktop and re-run.");
    ok(`Docker ${dockerRunning}`);
  }

  // ── 2. Environment ────────────────────────────────────────────────────────────

  step(2, "Setting up environment");

  if (IN_DOCKER) {
    ok("Running inside Docker — .env.local is mounted from host");
  } else if (!existsSync(ENV_FILE)) {
    if (!existsSync(ENV_EXAMPLE)) {
      fail(".env.example not found — are you in the OpenWind repository root?");
    }
    copyFileSync(ENV_EXAMPLE, ENV_FILE);
    ok("Created .env.local from .env.example");
  } else {
    ok(".env.local already exists — keeping existing values");
  }

  // ── 3. Infrastructure ─────────────────────────────────────────────────────────

  step(3, "Starting Docker services");

  if (IN_DOCKER) {
    ok("Running inside Docker — services are already up");
    info("Postgres, PgBouncer, Redis, Zitadel, API, Frontend");
  } else {
    run("docker compose up -d");
    ok("Docker services started");
    info("Postgres, PgBouncer, Redis, Zitadel, API, Frontend");
  }

  // ── 4. Health checks ──────────────────────────────────────────────────────────

  step(4, "Waiting for services to be healthy");

  info("This can take up to 60s on first boot while Zitadel initialises...");

  if (IN_DOCKER) {
    ok(
      "Postgres is ready (pgbouncer healthcheck passed before bootstrap started)",
    );
  } else {
    await waitForPostgres();
  }
  await waitForHttp(`${ZITADEL_HEALTH_URL}/healthz`, "Zitadel", 80, 3000);

  info(`Zitadel bootstrap URL: ${ZITADEL_BASE}`);

  // Extra buffer for Zitadel internal startup (database migrations, admin user creation)
  info("Giving Zitadel 10s to complete internal setup...");
  await sleep(10_000);

  // ── 5. Dependencies ───────────────────────────────────────────────────────────

  step(5, "Installing Node.js dependencies");
  if (IN_DOCKER) {
    ok("Running inside Docker — dependencies already installed in image");
  } else {
    run("pnpm install --frozen-lockfile");
    ok("All workspace packages installed");
  }

  // ── 6. Database ───────────────────────────────────────────────────────────────

  step(6, "Running database migrations and base seed");

  const dbEnv: NodeJS.ProcessEnv = { DOTENV_CONFIG_PATH: ".env.local" };
  if (IN_DOCKER && process.env["MIGRATION_DATABASE_URL"]) {
    dbEnv["MIGRATION_DATABASE_URL"] = process.env["MIGRATION_DATABASE_URL"];
  }
  // Run from within packages/db using pnpm exec so the local .bin/tsx is resolved.
  // This avoids turbo (whose workspace binary has the wrong platform binary on alpine).
  const dbPkgDir = join(ROOT, "packages", "db");
  run("pnpm exec tsx src/run-migrations.ts", { cwd: dbPkgDir, env: dbEnv });
  ok("Migrations applied");

  run("pnpm exec tsx src/seed.ts", { cwd: dbPkgDir, env: dbEnv });
  ok("Base data seeded (dev tenant, roles)");

  // ── 7. Auth setup ─────────────────────────────────────────────────────────────

  step(7, "Configuring Zitadel authentication");

  const authToken = await getAdminToken();
  console.log("");
  const { projectId, oidcClientId } = await runZitadelSetup(authToken);
  ok(`Project configured (id=${projectId})`);
  ok(`OIDC client id: ${oidcClientId}`);
  ok(".env.local updated with Zitadel credentials");

  // Recreate api + frontend so both pick up the new env vars written above.
  // `docker restart` reuses the baked-in env; `docker compose up -d` re-reads
  // env_file and the environment: block, recreating the container if anything changed.
  info("Recreating api and frontend containers with updated credentials...");
  try {
    execSync("docker compose up -d --force-recreate ow-backend ow-frontend", {
      stdio: "ignore",
      cwd: ROOT,
    });
    ok("ow-backend and ow-frontend recreated with updated credentials");
  } catch {
    warn(
      "Could not recreate containers — run `docker compose up -d --force-recreate ow-backend ow-frontend` manually",
    );
  }

  // ── 8. Demo users ─────────────────────────────────────────────────────────────

  step(8, "Creating demo users");

  await createDemoUser(authToken, projectId, {
    email: DEMO_ADMIN_EMAIL,
    firstName: "Admin",
    lastName: "Demo",
    userName: "owAdmin",
    role: "admin",
  });

  await createDemoUser(authToken, projectId, {
    email: DEMO_USER_EMAIL,
    firstName: "Portal",
    lastName: "User",
    userName: "owUser",
    role: "user",
  });

  // Test users — 5 users with "user" role for development / demo purposes
  const TEST_USERS = [
    {
      firstName: "Alice",
      lastName: "Tester",
      userName: "testUser1",
      email: "testUser1@openwind.local",
    },
    {
      firstName: "Bob",
      lastName: "Tester",
      userName: "testUser2",
      email: "testUser2@openwind.local",
    },
    {
      firstName: "Carol",
      lastName: "Tester",
      userName: "testUser3",
      email: "testUser3@openwind.local",
    },
    {
      firstName: "David",
      lastName: "Tester",
      userName: "testUser4",
      email: "testUser4@openwind.local",
    },
    {
      firstName: "Eve",
      lastName: "Tester",
      userName: "testUser5",
      email: "testUser5@openwind.local",
    },
  ];

  for (const u of TEST_USERS) {
    await createDemoUser(authToken, projectId, { ...u, role: "user" });
  }

  // ── 9. Module templates ───────────────────────────────────────────────────────

  step(9, "Module templates");

  ok(
    "Templates auto-seed on first visit to the Templates page — no action needed",
  );
  info('Or click "Seed Templates" on the Templates page if the list is empty.');

  // ── 10. Summary ───────────────────────────────────────────────────────────────

  step(10, "Bootstrap complete");

  const appUrl =
    process.env["CORS_ORIGIN"] ??
    `http://localhost:${process.env["ADMIN_UI_HOST_PORT"] ?? "3001"}`;

  console.log(`
${BOLD}${GREEN}  ✅  OpenWind is ready!${RESET}

  ${BOLD}Open the app in your browser:${RESET}

    ${CYAN}${BOLD}${appUrl}${RESET}

  ${BOLD}─────────────────────────────────────────────────────────────${RESET}
  ${BOLD}Login accounts${RESET}

  ${BOLD}OpenWind Admin${RESET}  (full platform access)
    Username:  ${YELLOW}owAdmin${RESET}
    Password:  ${YELLOW}${DEMO_PASSWORD}${RESET}

  ${BOLD}Portal User${RESET}  (end-user view)
    Username:  ${YELLOW}owUser${RESET}
    Password:  ${YELLOW}${DEMO_PASSWORD}${RESET}

  ${BOLD}Test Users${RESET}  (5 users with "user" role)
    testUser1 / testUser2 / testUser3 / testUser4 / testUser5
    Password:  ${YELLOW}${DEMO_PASSWORD}${RESET}

  ${BOLD}─────────────────────────────────────────────────────────────${RESET}
  ${BOLD}Zitadel console${RESET}  (identity provider — manage users, orgs, apps)

    URL:       ${CYAN}${ZITADEL_BROWSER_URL}${RESET}
    Username:  ${DIM}owZitadelAdmin@openwind.local${RESET}
    Password:  ${DIM}see ZITADEL_ADMIN_PASSWORD in .env.local${RESET}

  ${BOLD}─────────────────────────────────────────────────────────────${RESET}
  ${YELLOW}${BOLD}  ⚠  One last step:${RESET} restart the app containers to apply credentials:

    ${BOLD}docker compose restart ow-backend ow-frontend${RESET}

  ${BOLD}─────────────────────────────────────────────────────────────${RESET}
  ${DIM}Rebuild after code changes:  docker compose up -d --build${RESET}
  ${DIM}Reset everything:            docker compose down -v && docker compose --profile bootstrap run --rm bootstrap${RESET}
`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
