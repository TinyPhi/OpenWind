import type { DataProvider } from "@refinedev/core";
import { userManager, silentRefresh } from "./authProvider.js";

const apiUrl = "/api";

const REQUEST_TIMEOUT_MS = 8_000;

function toRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

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
  const headers = new Headers(options.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    throw {
      status: 0,
      message: isTimeout
        ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const user = await userManager.getUser();
  let token = user?.access_token;

  let response = await doFetch(url, options, token);

  // On 401, attempt silent token refresh and retry once.
  if (response.status === 401) {
    const newToken = await silentRefresh();
    if (newToken) {
      token = newToken;
      response = await doFetch(url, options, token);
    }
  }

  if (!response.ok) {
    const errorData = toRecord(await response.json().catch(() => ({})));
    const message =
      typeof errorData["message"] === "string"
        ? errorData["message"]
        : response.statusText || "Request failed";

    if (response.status === 401) {
      dispatchApiError(
        "auth",
        "Your session has expired. Please log in again.",
      );
    } else if (response.status >= 500) {
      dispatchApiError("server", message);
    }
    throw {
      status: response.status,
      message,
      isAuthError: response.status === 401,
    };
  }

  return response.json() as Promise<unknown>;
}

export const dataProvider: DataProvider = {
  getList: async ({ resource }) => {
    const url = `${apiUrl}/${resource}`;
    const result = toRecord(await fetchWithAuth(url));
    const raw = Array.isArray(result) ? result : result["data"];
    const data = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
    return { data: data as never[], total: data.length };
  },

  getOne: async ({ resource, id }) => {
    const url = `${apiUrl}/${resource}/${id}`;
    const result = toRecord(await fetchWithAuth(url));
    return { data: (result["data"] ?? result) as never };
  },

  create: async ({ resource, variables }) => {
    const url = `${apiUrl}/${resource}`;
    const result = toRecord(
      await fetchWithAuth(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(variables),
      }),
    );
    return { data: (result["data"] ?? result) as never };
  },

  update: async ({ resource, id, variables }) => {
    const url = `${apiUrl}/${resource}/${id}`;
    const result = toRecord(
      await fetchWithAuth(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(variables),
      }),
    );
    return { data: (result["data"] ?? result) as never };
  },

  deleteOne: async ({ resource, id }) => {
    const url = `${apiUrl}/${resource}/${id}`;
    const result = toRecord(await fetchWithAuth(url, { method: "DELETE" }));
    return { data: (result["data"] ?? result) as never };
  },

  getApiUrl: () => apiUrl,
};
