import { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";

export type OrgBrandingState =
  | { status: "loading" }
  | { status: "default" }
  | { status: "org"; name: string; logo: string | null };

function isOrgBranding(
  value: unknown,
): value is { name: string; logo: string | null } {
  if (typeof value !== "object" || value === null) return false;
  // Cast: reading two fields of an object this guard has just confirmed is non-null.
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    v["name"].trim() !== "" &&
    (v["logo"] === null || typeof v["logo"] === "string")
  );
}

/**
 * The header brand for the signed-in org (docs/specs/multi-org-sandbox.md R12). `loading` lets
 * the header hold its place instead of flashing the OpenWind brand before a sandbox's own;
 * `default` is every other tenant, and also any failed lookup, so the app stays usable.
 */
export function useOrgBranding(): OrgBrandingState {
  const [state, setState] = useState<OrgBrandingState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`${API_URL}/me/org`)
      .then((body) => {
        if (cancelled) return;
        const data = (body as { data?: unknown } | null)?.data;
        setState(
          isOrgBranding(data)
            ? { status: "org", name: data.name.trim(), logo: data.logo }
            : { status: "default" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "default" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
