import { userManager, silentRefresh, waitForAuth } from "../authProvider.js";

export const API_URL = "/api";

function dispatchApiError(type: "auth" | "server", message: string): void {
  window.dispatchEvent(
    new CustomEvent("api:error", { detail: { type, message } }),
  );
}

async function doFetch(
  url: string,
  options: RequestInit,
  token: string | undefined,
): Promise<Response> {
  // Resolve against the current page origin so absolute URLs, protocol-relative
  // URLs, and path traversal are all normalised before the origin comparison.
  const resolved = new URL(url, window.location.origin);
  if (resolved.origin !== window.location.origin) {
    throw new Error(
      "Refusing to send authenticated request to a cross-origin URL",
    );
  }
  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    options.method &&
    options.method !== "GET" &&
    !headers.has("Content-Type") &&
    !(options.body instanceof FormData)
  ) {
    // FormData bodies must NOT get an explicit Content-Type — the browser
    // sets multipart/form-data with the correct boundary itself; overriding
    // it here would break multipart parsing on the server.
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    // lgtm[js/server-side-request-forgery] origin checked against window.location.origin above; taint through resolved.href is a false positive
    return await fetch(resolved.href, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    throw new Error(isTimeout ? "Request timed out after 8s" : "Network error");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  await waitForAuth();
  const user = await userManager.getUser();
  let token = user?.access_token;

  let response = await doFetch(url, options, token);

  // On 401, attempt a silent token refresh and retry once.
  if (response.status === 401) {
    const newToken = await silentRefresh();
    if (newToken) {
      token = newToken;
      response = await doFetch(url, options, token);
    }
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      meta?: Record<string, unknown>;
    };
    const message =
      body.message ?? body.error ?? `Request failed (${response.status})`;

    if (response.status === 401) {
      dispatchApiError(
        "auth",
        "Your session has expired. Please log in again.",
      );
      const err = new Error(message) as Error & {
        status: number;
        meta?: Record<string, unknown>;
        isAuthError: boolean;
      };
      err.status = 401;
      // authProvider.ts's onError checks `isAuthError` to trigger auto-logout.
      err.isAuthError = true;
      throw err;
    }
    if (response.status >= 500) {
      dispatchApiError("server", message);
    }
    const err = new Error(message) as Error & {
      status: number;
      meta?: Record<string, unknown> | undefined;
    };
    err.status = response.status;
    err.meta = body.meta;
    throw err;
  }

  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return null;
  }
  return response.json();
}

export async function fetchRawWithAuth(url: string): Promise<Response> {
  const resolved = new URL(url, window.location.origin);
  if (resolved.origin !== window.location.origin) {
    throw new Error(
      "Refusing to send authenticated request to a cross-origin URL",
    );
  }
  await waitForAuth();
  const user = await userManager.getUser();
  let token = user?.access_token;
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // lgtm[js/server-side-request-forgery] same false positive as doFetch — origin checked above
  let response = await fetch(resolved.href, { headers });

  // On 401, attempt a silent token refresh and retry once — matches
  // fetchWithAuth's retry behavior, previously missing here.
  if (response.status === 401) {
    const newToken = await silentRefresh();
    if (newToken) {
      token = newToken;
      const retryHeaders = new Headers();
      retryHeaders.set("Authorization", `Bearer ${token}`);
      // lgtm[js/server-side-request-forgery] same false positive as doFetch — origin checked above
      response = await fetch(resolved.href, { headers: retryHeaders });
    }
  }

  return response;
}
