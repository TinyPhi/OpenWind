import { useEffect, useState } from "react";
import { API_URL } from "../lib/api.js";
import { isOrgBranding, type OrgBrandingState } from "./use-org-branding.js";

// Exactly what the server accepts (apps/api/src/routes/public/org-branding.ts): 16 lowercase hex
// characters. A value that fails it is never sent: the answer would be the generic page anyway.
const KEY_RE = /^[0-9a-f]{16}$/;
// A slow lookup must never hold the sign-in page: past this it is the generic page.
const LOOKUP_TIMEOUT_MS = 4000;

/**
 * The login page's brand for a sandbox login link, /login?org=<login key> (docs/specs/multi-org-sandbox.md
 * R13). Unauthenticated, so a plain fetch: fetchWithAuth waits for a session this page exists to
 * create.
 *
 * No key, or a malformed one, is the generic page at once with no request. Every other way it can
 * go wrong -- unknown slug, a real tenant, a non-active sandbox, rate limited, a timeout, a network
 * error, a malformed body -- is the same generic page, so the visitor cannot tell the cases apart.
 * `loading` holds the brand's space invisibly, so a sandbox visitor never sees OpenWind flash first.
 */
export function useLoginOrgBranding(key: string | null): OrgBrandingState {
  const usable = key !== null && KEY_RE.test(key) ? key : null;
  const [state, setState] = useState<OrgBrandingState>(
    usable === null ? { status: "default" } : { status: "loading" },
  );

  useEffect(() => {
    if (usable === null) {
      setState({ status: "default" });
      return;
    }
    setState({ status: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    let cancelled = false;
    fetch(`${API_URL}/public/org-branding/${encodeURIComponent(usable)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { data?: unknown } | null;
        return body?.data;
      })
      .then((data) => {
        if (cancelled) return;
        setState(
          isOrgBranding(data)
            ? { status: "org", name: data.name.trim(), logo: data.logo }
            : { status: "default" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "default" });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [usable]);

  return usable === null ? { status: "default" } : state;
}
