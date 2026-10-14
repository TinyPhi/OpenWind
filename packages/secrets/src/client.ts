import { env } from "@platform/config";
import { logger } from "@platform/logger";

type TokenAuth = { type: "token"; token: string };
type AppRoleAuth = { type: "approle"; roleId: string; secretId: string };
type Auth = TokenAuth | AppRoleAuth;

// A slow or unreachable OpenBao must not hang a webhook request or a worker job
// until the socket gives up (ADR-023 Decision 4).
const REQUEST_TIMEOUT_MS = 10_000;
// Network errors, 429 and 5xx (503 while sealed) are retried; 4xx never is.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;
// Renew (or re-login) at about 2/3 of the token's lease, so a real request
// never meets an expired token.
const RENEW_AT_FRACTION = 2 / 3;
// A renewal that leaves less than this is near token_max_ttl: log in again.
const MIN_USEFUL_LEASE_MS = 60_000;

interface CachedToken {
  token: string;
  renewAt: number;
  renewable: boolean;
}

interface AuthResponse {
  auth: { client_token: string; lease_duration: number; renewable: boolean };
}

let cached: CachedToken | null = null;
// Single flight: concurrent callers share one login or renewal instead of each
// starting their own (wasted calls and audit noise after every expiry).
let refreshInFlight: Promise<CachedToken> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(
  url: string,
  init: Parameters<typeof fetch>[1],
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!isRetryableStatus(res.status) || attempt >= MAX_ATTEMPTS) {
        return res;
      }
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
    }
    const jitter = Math.random() * RETRY_BASE_DELAY_MS;
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter);
  }
}

function toCachedToken(data: AuthResponse): CachedToken {
  const leaseMs = data.auth.lease_duration * 1000;
  return {
    token: data.auth.client_token,
    // lease_duration 0 means the token never expires.
    renewAt: leaseMs > 0 ? Date.now() + leaseMs * RENEW_AT_FRACTION : Infinity,
    renewable: data.auth.renewable,
  };
}

async function login(auth: AppRoleAuth): Promise<CachedToken> {
  const res = await fetchWithRetry(
    `${env.OPENBAO_ADDR}/v1/auth/approle/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role_id: auth.roleId, secret_id: auth.secretId }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenBao AppRole login failed (${res.status}): ${body}`);
  }

  return toCachedToken((await res.json()) as AuthResponse);
}

async function renew(current: CachedToken): Promise<CachedToken | null> {
  const res = await fetchWithRetry(
    `${env.OPENBAO_ADDR}/v1/auth/token/renew-self`,
    {
      method: "POST",
      headers: {
        "x-vault-token": current.token,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  if (!res.ok) return null;

  const data = (await res.json()) as AuthResponse;
  if (data.auth.lease_duration * 1000 < MIN_USEFUL_LEASE_MS) return null;
  return toCachedToken(data);
}

async function refresh(auth: AppRoleAuth): Promise<CachedToken> {
  if (cached?.renewable) {
    try {
      const renewed = await renew(cached);
      if (renewed) return renewed;
    } catch (err) {
      logger.warn({ err }, "OpenBao token renewal failed; logging in again");
    }
  }
  return login(auth);
}

async function getToken(auth: Auth): Promise<string> {
  if (auth.type === "token") return auth.token;

  if (cached && Date.now() < cached.renewAt) return cached.token;

  refreshInFlight ??= refresh(auth)
    .then((token) => {
      cached = token;
      return token;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return (await refreshInFlight).token;
}

function buildAuth(): Auth {
  if (env.OPENBAO_TOKEN) {
    return { type: "token", token: env.OPENBAO_TOKEN };
  }
  // Zod refine in env.ts guarantees both are present when OPENBAO_TOKEN is absent
  const roleId = env.OPENBAO_ROLE_ID ?? "";
  const secretId = env.OPENBAO_SECRET_ID ?? "";
  return { type: "approle", roleId, secretId };
}

export async function openbaoRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = buildAuth();

  for (let authAttempt = 1; ; authAttempt++) {
    const token = await getToken(auth);

    const res = await fetchWithRetry(`${env.OPENBAO_ADDR}/v1/${path}`, {
      method,
      headers: {
        "x-vault-token": token,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    // A 403 can mean the AppRole token expired or was revoked: drop it, log in
    // again and retry the same request once.
    if (res.status === 403 && auth.type === "approle" && authAttempt === 1) {
      if (cached?.token === token) cached = null;
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      logger.error(
        { path, status: res.status, body: text },
        "OpenBao request failed",
      );
      if (res.status === 403) cached = null;
      throw new Error(`OpenBao error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }
}

// Test-only: module state persists across tests in one file.
export function __resetOpenBaoClientForTests(): void {
  cached = null;
  refreshInFlight = null;
}
