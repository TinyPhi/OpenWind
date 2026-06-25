import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Load .env.local from the monorepo root (walk up from cwd until we find it)
function findEnvLocal(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envLocalPath = findEnvLocal();
if (envLocalPath) {
  loadDotenv({ path: envLocalPath, override: false });
}

// Derive individual URL vars from ZITADEL_URL / APP_URL if not already set.
// This lets .env.local use just two base vars and have everything flow from them.
// Individual vars still take priority when set explicitly (??= never overwrites).
const _raw = process.env as Record<string, string | undefined>;
if (_raw["ZITADEL_URL"]) {
  const z = _raw["ZITADEL_URL"];
  _raw["ZITADEL_ISSUER"] ??= z;
  _raw["ZITADEL_INTROSPECTION_URL"] ??= `${z}/oauth/v2/introspect`;
  _raw["ZITADEL_JWKS_URL"] ??= `${z}/oauth/v2/keys`;
}
if (_raw["APP_URL"]) {
  _raw["CORS_ORIGIN"] ??= _raw["APP_URL"];
}

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    // ── Base URL vars (new — set these in .env.local instead of the derived vars below) ──
    // ZITADEL_URL: single source for all Zitadel endpoints (issuer, JWKS, introspection).
    //   Local dev default: http://localhost:10405 (or http://zitadel:8080 inside Docker)
    //   Production:        https://owzitadel.yourcompany.com
    ZITADEL_URL: z.string().url().optional(),
    // APP_URL: the URL the frontend is served from. Drives CORS_ORIGIN.
    //   Local dev default: http://localhost:3001
    //   Production:        https://openwind.yourcompany.com
    APP_URL: z.string().url().optional(),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MIN: z.coerce.number().int().min(1).default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
    REDIS_URL: z.string().url(),
    ZITADEL_ISSUER: z.string().url(),
    // Override the JWKS fetch URL when running inside Docker (issuer claim still
    // matches localhost:8080 in the JWT, but we fetch keys via container hostname).
    ZITADEL_JWKS_URL: z.string().url().optional(),
    // Required — used by JWKS middleware to validate the JWT aud claim.
    // ZITADEL_PROJECT_ID may fall back to this value in zitadel-management.ts.
    ZITADEL_AUDIENCE: z.string(),
    // Dev fallback: used as tenantId when urn:zitadel:iam:org:id is absent (instance admin login).
    // Must never be set in production — it bypasses tenant isolation for instance-admin logins.
    DEV_TENANT_ID: z.string().optional(),
    // Service account key JSON (raw JSON string from Zitadel console).
    // Used to call the Zitadel Management API for live role/user queries.
    // Store the full JSON string. Never commit this value.
    ZITADEL_SERVICE_ACCOUNT_KEY: z.string().optional(),
    // Base64-encoded service account key — written by bootstrap.
    // Fallback when ZITADEL_SERVICE_ACCOUNT_KEY is absent.
    ZITADEL_KEY_JSON: z.string().optional(),
    // Project ID — defaults to ZITADEL_AUDIENCE which is the project ID in this setup.
    ZITADEL_PROJECT_ID: z.string().optional(),
    // Token introspection — used for sensitive ops that require active-token verification
    ZITADEL_INTROSPECTION_URL: z.string().url(),
    ZITADEL_INTROSPECTION_CLIENT_ID: z.string(),
    ZITADEL_INTROSPECTION_CLIENT_SECRET: z.string(),
    // Required in production — the exact origin the admin-ui is served from.
    // In development/test the API accepts all http://localhost:* origins.
    CORS_ORIGIN: z.string().url().optional(),
    NOVU_API_KEY: z.string(),
    S3_ENDPOINT: z.string().url(),
    S3_BUCKET: z.string(),
    S3_ACCESS_KEY: z.string(),
    S3_SECRET_KEY: z.string(),
    ANTHROPIC_API_KEY: z.string(),
    // SSRF protection — comma-separated extra CIDR ranges to block on outbound webhooks
    // (hardcoded RFC 1918 / loopback / link-local ranges are always blocked regardless)
    SSRF_BLOCK_CIDRS: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      ),
    // ClamAV — virus scanning for uploaded files (2A platform services)
    CLAMAV_HOST: z.string().default("localhost"),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    // OpenBao — Transit envelope encryption for connector credentials
    OPENBAO_ADDR: z.string().url(),
    OPENBAO_TRANSIT_KEY: z.string().default("platform-credentials"),
    // Dev: static root token. Prod: leave unset and use AppRole instead.
    OPENBAO_TOKEN: z.string().optional(),
    // AppRole auth (production) — both required together when OPENBAO_TOKEN is absent
    OPENBAO_ROLE_ID: z.string().optional(),
    OPENBAO_SECRET_ID: z.string().optional(),
  })
  .refine(
    (v) =>
      v.OPENBAO_TOKEN !== undefined ||
      (v.OPENBAO_ROLE_ID !== undefined && v.OPENBAO_SECRET_ID !== undefined),
    {
      message:
        "Either OPENBAO_TOKEN (dev) or both OPENBAO_ROLE_ID and OPENBAO_SECRET_ID (prod) must be set",
    },
  )
  .refine(
    (v) => !(v.NODE_ENV === "production" && v.DEV_TENANT_ID !== undefined),
    {
      message:
        "DEV_TENANT_ID must not be set in production — it bypasses tenant isolation",
    },
  )
  .refine((v) => v.NODE_ENV !== "production" || v.CORS_ORIGIN !== undefined, {
    message:
      "CORS_ORIGIN must be set in production to restrict allowed origins",
  });

export const env = EnvSchema.parse(process.env);
export type Env = z.infer<typeof EnvSchema>;
