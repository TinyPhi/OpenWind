import { UserManager, WebStorageStateStore } from "oidc-client-ts";

declare const window: Window & { __CONFIG__?: Record<string, string> };

function cfg(key: string, fallback = ""): string {
  return window.__CONFIG__?.[key] ?? fallback;
}

const issuer = cfg("ZITADEL_ISSUER", "http://localhost:8080");
const clientId = cfg("ZITADEL_OIDC_CLIENT_ID");
const clientSecret = cfg("ZITADEL_OIDC_CLIENT_SECRET");

export const userManager = new UserManager({
  authority: issuer,
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uri: window.location.origin + "/auth/callback",
  response_type: "code",
  scope:
    "openid profile email urn:zitadel:iam:org:project:roles urn:zitadel:iam:org:id offline_access",
  post_logout_redirect_uri: window.location.origin + "/login",
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  automaticSilentRenew: false,
  loadUserInfo: true,
});

// API_URL is injected at container startup via docker-entrypoint.sh → window.__CONFIG__.
// Falls back to localhost:3000 for local dev (no Docker).
export const API_URL = cfg("API_URL", "http://localhost:3000");

export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const user = await userManager.getUser();
  const token = user?.access_token;

  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    options.method &&
    options.method !== "GET" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    throw new Error(isTimeout ? "Request timed out" : "Network error");
  }
  clearTimeout(timer);

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(body.message ?? `Request failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchRawWithAuth(url: string): Promise<Response> {
  const user = await userManager.getUser();
  const token = user?.access_token;
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { headers });
}
