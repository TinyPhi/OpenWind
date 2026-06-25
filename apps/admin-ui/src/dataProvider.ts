import type { DataProvider } from "@refinedev/core";
import { userManager } from "./authProvider.js";

const apiUrl = "/api";

const REQUEST_TIMEOUT_MS = 8_000;

function toRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

async function fetchWithAuth(
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const user = await userManager.getUser();
  const token = user?.access_token;

  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    throw {
      status: 0,
      message: isTimeout
        ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : "Network error",
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    const errorData = toRecord(await response.json().catch(() => ({})));
    throw {
      status: response.status,
      message:
        typeof errorData["message"] === "string"
          ? errorData["message"]
          : response.statusText || "Request failed",
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
