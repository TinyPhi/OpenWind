import { useEffect, useState } from "react";
import { fetchWithAuth, API_URL } from "../lib/api.js";

export type OrgBrandingState =
  | { status: "loading" }
  | { status: "default" }
  | { status: "org"; name: string; logo: string | null };

// The server and tenants_logo_check already allow only these; checked again here so a logo that
// is ever anything else (a remote URL, say) is never put into an <img>.
const RASTER_DATA_URL = /^data:image\/(png|jpeg|webp);base64,/;

export function isOrgBranding(
  value: unknown,
): value is { name: string; logo: string | null } {
  if (typeof value !== "object" || value === null) return false;
  // Cast: reading two fields of an object this guard has just confirmed is non-null.
  const v = value as Record<string, unknown>;
  return (
    typeof v["name"] === "string" &&
    v["name"].trim() !== "" &&
    (v["logo"] === null ||
      (typeof v["logo"] === "string" && RASTER_DATA_URL.test(v["logo"])))
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
