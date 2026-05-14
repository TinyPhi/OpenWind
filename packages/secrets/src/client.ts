import { env } from "@platform/config";
import { logger } from "@platform/logger";

type TokenAuth = { type: "token"; token: string };
type AppRoleAuth = { type: "approle"; roleId: string; secretId: string };
type Auth = TokenAuth | AppRoleAuth;

let cachedToken: string | null = null;

async function getToken(auth: Auth): Promise<string> {
  if (auth.type === "token") return auth.token;

  if (cachedToken) return cachedToken;

  const res = await fetch(`${env.OPENBAO_ADDR}/v1/auth/approle/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role_id: auth.roleId, secret_id: auth.secretId }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenBao AppRole login failed: ${body}`);
  }

  const data = (await res.json()) as { auth: { client_token: string } };
  cachedToken = data.auth.client_token;
  return cachedToken;
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
  const token = await getToken(auth);

  const res = await fetch(`${env.OPENBAO_ADDR}/v1/${path}`, {
    method,
    headers: {
      "x-vault-token": token,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(
      { path, status: res.status, body: text },
      "OpenBao request failed",
    );
    // Invalidate cached AppRole token on 403 so next call re-authenticates
    if (res.status === 403) cachedToken = null;
    throw new Error(`OpenBao error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}
