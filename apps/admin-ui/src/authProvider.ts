import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import type { User } from "oidc-client-ts";
import type { AuthProvider } from "@refinedev/core";

declare const window: Window & {
  __CONFIG__?: {
    ZITADEL_ISSUER?: string;
    ZITADEL_OIDC_CLIENT_ID?: string;
    ZITADEL_OIDC_CLIENT_SECRET?: string;
  };
};

// Runtime config (Docker) wins; Vite build-time env vars (local dev) are the fallback.
// import.meta.env keys are not statically declared so we cast to a generic record.
const viteEnv = import.meta.env as Record<string, string | undefined>;
const cfg = window.__CONFIG__ ?? {};
const issuer =
  cfg.ZITADEL_ISSUER ??
  viteEnv["VITE_ZITADEL_ISSUER"] ??
  "http://localhost:8080";
const clientId =
  cfg.ZITADEL_OIDC_CLIENT_ID ?? viteEnv["VITE_ZITADEL_OIDC_CLIENT_ID"] ?? "";
const clientSecret =
  cfg.ZITADEL_OIDC_CLIENT_SECRET ??
  viteEnv["VITE_ZITADEL_OIDC_CLIENT_SECRET"] ??
  "";

export const userManager = new UserManager({
  authority: issuer,
  client_id: clientId,
  client_secret: clientSecret,
  redirect_uri: window.location.origin + "/auth/callback",
  response_type: "code",
  scope:
    "openid profile email urn:zitadel:iam:org:project:roles urn:zitadel:iam:user:resourceowner offline_access",
  post_logout_redirect_uri: window.location.origin + "/login",
  userStore: new WebStorageStateStore({ store: window.localStorage }),
  automaticSilentRenew: true,
  loadUserInfo: true,
});

// ── Auth-ready gate ───────────────────────────────────────────────────────────
// Resolves as soon as a valid access_token is confirmed available.
// — On page reload: resolves immediately (user already in localStorage).
// — On initial login: resolves when signinCallback() fires the userLoaded event.
// fetchWithAuth awaits this before reading the token so it never sends a
// request with a missing Bearer header due to a post-callback race condition.

let _authReadyResolve: (() => void) | undefined;
const _authReady = new Promise<void>((resolve) => {
  _authReadyResolve = resolve;
});

// Check localStorage immediately (page reload path).
void userManager.getUser().then((u) => {
  if (u && !u.expired) _authReadyResolve?.();
});

// Resolve whenever a user is stored (initial login path).
userManager.events.addUserLoaded((_u: User) => {
  _authReadyResolve?.();
});

// 3 s safety-valve: never block requests longer than this.
const _authTimeout = new Promise<void>((r) => setTimeout(r, 3000));

export function waitForAuth(): Promise<void> {
  return Promise.race([_authReady, _authTimeout]);
}

// Attempt a silent token refresh using the stored refresh_token.
// Returns the new access_token on success, null on failure.
//
// Single-flight: concurrent 401s (e.g. several in-flight requests all racing
// at token expiry) previously each fired their own independent signinSilent()
// call — N parallel calls racing on the same localStorage write. All callers
// arriving while a refresh is already in progress now share that one promise.
let _pendingRefresh: Promise<string | null> | undefined;

export function silentRefresh(): Promise<string | null> {
  if (_pendingRefresh) return _pendingRefresh;

  _pendingRefresh = userManager
    .signinSilent()
    .then((user) => user?.access_token ?? null)
    .catch(() => null)
    .finally(() => {
      _pendingRefresh = undefined;
    });

  return _pendingRefresh;
}

export const authProvider: AuthProvider = {
  login: async () => {
    await userManager.signinRedirect();
    return { success: true };
  },
  logout: async () => {
    const user = await userManager.getUser();
    await userManager.clearStaleState();
    try {
      // Ends the session at Zitadel too, not just locally — signoutRedirect
      // navigates the browser to Zitadel's end-session endpoint, which then
      // redirects back to post_logout_redirect_uri. It clears the local user
      // itself, so no separate removeUser() call is needed.
      await userManager.signoutRedirect(
        user?.id_token ? { id_token_hint: user.id_token } : undefined,
      );
    } catch {
      // Zitadel unreachable (network timeout, service down) — fall back to
      // a local-only logout so the user isn't stuck on the current page
      // with no redirect target.
      await userManager.removeUser();
      return { success: true, redirectTo: "/login" };
    }
    return { success: true };
  },
  onError: (error: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      "isAuthError" in error
    ) {
      const e = error as { status: number; isAuthError: boolean };
      if (e.status === 401 && e.isAuthError) {
        return Promise.resolve({
          logout: true,
          redirectTo: "/login",
          error: error as unknown as Error,
        });
      }
    }
    return Promise.resolve({ error: error as unknown as Error });
  },
  check: async () => {
    if (window.location.pathname === "/auth/callback") {
      return { authenticated: true };
    }
    const user = await userManager.getUser();
    if (user && !user.expired) {
      return { authenticated: true };
    }
    // Token expired — attempt silent refresh before giving up.
    if (user?.refresh_token) {
      const newToken = await silentRefresh();
      if (newToken) return { authenticated: true };
    }
    return {
      authenticated: false,
      redirectTo: "/login",
      error: new Error("Unauthenticated"),
    };
  },
  getPermissions: async () => {
    const user = await userManager.getUser();
    if (user?.profile) {
      const rolesMap = (user.profile["urn:zitadel:iam:org:project:roles"] ??
        {}) as Record<string, Record<string, Record<string, string>>>;
      return Object.keys(rolesMap);
    }
    return [];
  },
  getIdentity: async () => {
    const user = await userManager.getUser();
    if (user?.profile) {
      return {
        id: user.profile.sub,
        name:
          user.profile.name ??
          user.profile.preferred_username ??
          user.profile.email ??
          "Admin User",
        email: user.profile.email ?? "",
        avatar:
          user.profile.picture ??
          `https://api.dicebear.com/7.x/initials/svg?seed=${user.profile.name ?? "Admin"}&fontSize=38&fontWeight=700&chars=2`,
      };
    }
    return null;
  },
};
