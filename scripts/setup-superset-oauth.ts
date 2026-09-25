/**
 * Provision the Zitadel OIDC application Superset logs users in with (Stage 2).
 *
 * Stage 1 needs no such app: users never reach Superset, and the only identity
 * in play is a guest token our API mints. Stage 2 puts Superset on its own URL
 * with a real login, so it needs a client of its own.
 *
 * It cannot reuse admin-ui's client. That one is a public PKCE app with no
 * secret, which is right for a browser SPA and wrong for a server-side login —
 * Superset exchanges the authorization code from its own backend and has to
 * authenticate itself while doing so. So this creates a *confidential* web app
 * (BASIC auth method), which is what makes Zitadel issue a client secret at all.
 *
 * Idempotent: re-running updates the redirect URIs of the existing app rather
 * than creating a second one. The secret is only returned at creation, so a
 * re-run prints a reminder instead of a value it cannot recover.
 */
import { createPrivateKey } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

const ZITADEL_URL = process.env["ZITADEL_URL"] ?? "http://localhost:8080";
const PROJECT_ID = process.env["ZITADEL_AUDIENCE"] ?? "";
const APP_NAME = "OpenWind Superset";
const SUPERSET_URL =
  process.env["SUPERSET_SITE_URL"] ?? "http://localhost:8088";

type KeyConfig = { keyId: string; key: string; userId: string };

function serviceAccountKey(): KeyConfig {
  const raw =
    process.env["ZITADEL_SERVICE_ACCOUNT_KEY"] ??
    process.env["ZITADEL_KEY_JSON"];
  if (!raw) throw new Error("ZITADEL_SERVICE_ACCOUNT_KEY is not set");
  // The same value is stored base64-encoded in some environments and as raw
  // JSON in others; accept both rather than making the caller care.
  const text = raw.trim().startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8");
  const parsed = JSON.parse(text) as KeyConfig;
  return parsed;
}

async function accessToken(): Promise<string> {
  const cfg = serviceAccountKey();
  // Zitadel hands out PKCS#1 or PKCS#8 depending on when the key was made;
  // importPKCS8 only takes the latter, so normalise through Node first.
  const exported = cfg.key.includes("BEGIN PRIVATE KEY")
    ? cfg.key
    : createPrivateKey(cfg.key).export({ type: "pkcs8", format: "pem" });
  const pem =
    typeof exported === "string" ? exported : exported.toString("utf8");

  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: cfg.keyId })
    .setIssuedAt()
    .setIssuer(cfg.userId)
    .setSubject(cfg.userId)
    .setAudience(ZITADEL_URL)
    .setExpirationTime("1h")
    .sign(await importPKCS8(pem, "RS256"));

  const res = await fetch(`${ZITADEL_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      scope: "openid profile email urn:zitadel:iam:org:project:id:zitadel:aud",
      assertion,
    }),
  });
  if (!res.ok)
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api(
  path: string,
  token: string,
  body?: unknown,
  method = "POST",
) {
  const res = await fetch(`${ZITADEL_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function main(): Promise<void> {
  if (!PROJECT_ID) throw new Error("ZITADEL_AUDIENCE (project id) is not set");
  const token = await accessToken();

  // Flask-AppBuilder fixes this callback path from the provider name; it is not
  // ours to choose, and a mismatch fails the login with a redirect_uri error
  // rather than anything that points at the cause.
  const redirectUri = `${SUPERSET_URL}/oauth-authorized/zitadel`;
  const config = {
    redirectUris: [redirectUri],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: [
      "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
      "OIDC_GRANT_TYPE_REFRESH_TOKEN",
    ],
    appType: "OIDC_APP_TYPE_WEB",
    // BASIC, not NONE: a confidential client, so Zitadel issues a secret.
    authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
    postLogoutRedirectUris: [SUPERSET_URL, `${SUPERSET_URL}/login/`],
    accessTokenType: "OIDC_TOKEN_TYPE_JWT",
    // Roles must ride on the token: Superset maps them to its own roles at
    // every login, and without assertion the claim simply is not there.
    accessTokenRoleAssertion: true,
    idTokenRoleAssertion: true,
    idTokenUserinfoAssertion: true,
  };

  const search = (await api(
    `/management/v1/projects/${PROJECT_ID}/apps/_search`,
    token,
    {
      queries: [
        { nameQuery: { name: APP_NAME, method: "TEXT_QUERY_METHOD_EQUALS" } },
      ],
    },
  )) as {
    result?: { id: string; name: string; oidcConfig?: { clientId: string } }[];
  };

  const existing = search.result?.find((a) => a.name === APP_NAME);

  if (existing?.oidcConfig?.clientId) {
    // Verified live against a running Zitadel v4.15.1 instance: the app
    // itself lives at /apps/{id} (that path works fine, confirmed via a
    // plain GET), but its OIDC config sub-resource updates at
    // /apps/{id}/oidc_config, not /apps/{id}/oidc — the latter 404s even
    // though the app genuinely exists. Not documented anywhere obvious;
    // found by testing both against the real API rather than assuming.
    await api(
      `/management/v1/projects/${PROJECT_ID}/apps/${existing.id}/oidc_config`,
      token,
      config,
      "PUT",
    );
    console.log(`App "${APP_NAME}" already exists — redirect URIs updated.`);
    console.log(`  SUPERSET_OAUTH_CLIENT_ID=${existing.oidcConfig.clientId}`);
    console.log(
      "  Client secret is shown only once, at creation. If it was not kept,\n" +
        "  regenerate it in Zitadel (Applications > " +
        APP_NAME +
        " > Regenerate secret).",
    );
  } else {
    const created = (await api(
      `/management/v1/projects/${PROJECT_ID}/apps/oidc`,
      token,
      { name: APP_NAME, ...config },
    )) as { clientId: string; clientSecret?: string };
    console.log(`Created OIDC app "${APP_NAME}".`);
    console.log(`  SUPERSET_OAUTH_CLIENT_ID=${created.clientId}`);
    console.log(
      `  SUPERSET_OAUTH_CLIENT_SECRET=${created.clientSecret ?? "(none returned)"}`,
    );
  }
  console.log(`  redirect URI registered: ${redirectUri}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
