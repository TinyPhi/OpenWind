import type { DataProvider } from "@refinedev/core";
import { fetchWithAuth } from "./lib/api.js";

const apiUrl = "/api";

function toRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
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
