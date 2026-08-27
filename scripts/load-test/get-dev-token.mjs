#!/usr/bin/env node
// get-dev-token.mjs — mints a single access token via Zitadel's JWT Profile
// (jwt-bearer) grant, for the load-test scripts in this directory to reuse
// across all simulated concurrent virtual users.
//
// This deliberately reuses the exact grant scripts/setup-dev-auth.ts already
// uses for headless provisioning (see that file's getTokenFromKeyJson) rather
// than inventing new auth plumbing.
//
// Why one shared token, not one per simulated tenant: in this dev stack,
// NODE_ENV !== "production" forces every valid JWT's tenantId to
// env.DEV_TENANT_ID regardless of which Zitadel org signed it (see
// packages/auth/src/jwks.ts) — there is no per-request tenant override.
// Building real multi-org Zitadel provisioning just to get distinct tokens
// would be a new feature, not load-test tooling. This script's concurrency
// therefore measures genuine DB/connection-pool contention (the actual #296
// question) under N concurrent virtual users, not per-tenant RLS query-path
// differences — see scripts/load-test/README.md for the full caveat.
//
// Usage:
//   node scripts/load-test/get-dev-token.mjs
//   (reads ZITADEL_KEY_JSON from .env.local or the environment, same as
//   scripts/setup-dev-auth.ts)
//
// Prints the access token to stdout on success (nothing else — safe to
// capture with `TOKEN=$(node scripts/load-test/get-dev-token.mjs)`).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";

const ZITADEL_BASE = process.env.ZITADEL_BASE_URL ?? "http://localhost:8080";
const ENV_FILE_PATH = join(process.cwd(), ".env.local");

function fail(msg) {
  console.error(`[get-dev-token] ERROR: ${msg}`);
  process.exit(1);
}

function readKeyJsonFromEnvFile() {
  const fromEnv = process.env.ZITADEL_KEY_JSON;
  const raw =
    fromEnv ??
    (() => {
      if (!existsSync(ENV_FILE_PATH)) return undefined;
      const line = readFileSync(ENV_FILE_PATH, "utf8")
        .split("\n")
        .find((l) => l.startsWith("ZITADEL_KEY_JSON="));
      return line?.slice("ZITADEL_KEY_JSON=".length);
    })();
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function signJwt(payload, privateKeyPem, keyId) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64url({ alg: "RS256", typ: "JWT", kid: keyId });
  const body = b64url(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(privateKeyPem, "base64url")}`;
}

async function getTokenFromKeyJson(keyJson) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(
    { iss: keyJson.userId, sub: keyJson.userId, aud: [ZITADEL_BASE], iat: now, exp: now + 60 },
    keyJson.key,
    keyJson.keyId,
  );
  const res = await fetch(`${ZITADEL_BASE}/oauth/v2/token`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      scope: "openid urn:zitadel:iam:org:project:id:zitadel:aud",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JWT token exchange failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const keyJson = readKeyJsonFromEnvFile();
  if (!keyJson) {
    fail(
      "No ZITADEL_KEY_JSON found in .env.local or the environment. Run `pnpm bootstrap` " +
        "(or scripts/setup-dev-auth.ts's documented flow) first — the load-test tooling " +
        "reuses that same headless credential, it does not mint its own.",
    );
  }
  try {
    const token = await getTokenFromKeyJson(keyJson);
    process.stdout.write(token);
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
}

main();
