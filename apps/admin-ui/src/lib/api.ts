import { userManager } from "../authProvider.js";

export const API_URL = "/api";

export async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const user = await userManager.getUser();
  const token = user?.access_token;

  const headers = new Headers(options.headers as HeadersInit | undefined);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (
    options.method &&
    options.method !== "GET" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

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
    throw new Error(isTimeout ? "Request timed out after 8s" : "Network error");
  }
  clearTimeout(timer);

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(body.message ?? `Request failed: ${response.status}`);
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
  const user = await userManager.getUser();
  const token = user?.access_token;
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { headers });
}
