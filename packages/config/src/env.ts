import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { join } from "node:path";
// Reporting (3G) development-only secret defaults live in dev-defaults.ts, so
// the one list the guards and the tests share has a single, obvious home.
import {
  DEV_SUPERSET_SECRET_KEY,
  DEV_SUPERSET_GUEST_TOKEN_SECRET,
  DEV_SUPERSET_SERVICE_ACCOUNT_PASSWORD,
  DEV_SUPERSET_ADMIN_PASSWORD,
} from "./dev-defaults.js";

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
    // Post-auth, tenant-scoped rate limit (#195) — requireAuth() (@platform/auth)
    // enforces this per verified auth.tenantId, independent of the pre-auth
    // IP-based flood guard in apps/api's rate-limit middleware. Raised from
    // the original 100 default (2026-08-11) — a single ticket detail page
    // load alone fans out to ~8-10 parallel GET requests, and this limit is
    // shared across every concurrently active user in the tenant, not
    // per-user; 100/min collapsed under completely normal 2-user concurrent
    // browsing, not abuse. See security.md for the current documented value.
    RATE_LIMIT_TENANT_PER_MIN: z.coerce.number().int().positive().default(600),
    // docs/temporal-scheduler-design.md §3.1/§3.5 — the scheduler tick's poll
    // interval and its cap on missed fires executed in one catch-up run
    // (SCHEDULE_CATCH_UP_MAX exists specifically so a long worker outage on a
    // frequent rule can't flood the tenant with hundreds of retroactive tickets).
    SCHEDULE_TICK_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    SCHEDULE_CATCH_UP_MAX: z.coerce.number().int().min(1).max(100).default(24),
    // ADR-012 Phase G, ADR-013 — two more tiers on top of the tenant one
    // above, specific to third-party API-key traffic: aggregate per-key
    // (this key's total request volume, regardless of which acting person)
    // and per-(key,person) (a single acting person's own share of that
    // key's traffic). Whichever of the three tiers is hit first applies.
    RATE_LIMIT_API_KEY_PER_MIN: z.coerce.number().int().positive().default(200),
    RATE_LIMIT_API_KEY_PERSON_PER_MIN: z.coerce
      .number()
      .int()
      .positive()
      .default(20),
    // ADR-012 Phase G, spec R6 — the third-party acting-person JWT path
    // (verifyJwtWithAudience) rejects a token whose iat is older than this,
    // independent of Zitadel's own exp-based expiry. A startup warning (not
    // a hard failure — a wide value isn't invalid config, just worth a
    // human's attention) fires below if this is ever set above 30 minutes.
    JWT_MAX_TOKEN_AGE_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    ZITADEL_ISSUER: z.string().url(),
    // Override the JWKS fetch URL when running inside Docker (issuer claim still
    // matches localhost:8080 in the JWT, but we fetch keys via container hostname).
    ZITADEL_JWKS_URL: z.string().url().optional(),
    // Required — used by JWKS middleware to validate the JWT aud claim.
    // .min(1): an empty string would otherwise pass z.string() and silently
    // disable audience validation at runtime (jwks.ts) instead of failing
    // closed here at boot.
    // ZITADEL_PROJECT_ID may fall back to this value in zitadel-management.ts.
    ZITADEL_AUDIENCE: z.string().min(1),
    // Dev fallback: used as tenantId when urn:zitadel:iam:user:resourceowner:id is absent (instance admin login).
    // Must never be set in production — it bypasses tenant isolation for instance-admin logins.
    DEV_TENANT_ID: z.string().optional(),
    // The Zitadel org UUID that belongs to platform operators. When set, admin
    // tenant lifecycle routes (GET/PATCH/DELETE /admin/tenants/:id) verify that
    // the caller's auth.tenantId matches this value — blocking a customer user
    // who has been granted 'superadmin' from accessing other tenants' lifecycle
    // routes. Unset in dev/test (where DEV_TENANT_ID already unifies tenantIds).
    PLATFORM_ORG_ID: z.string().uuid().optional(),
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
    // In-app notification hub (docs/specs/in-app-notification-hub.md).
    // Single hardcoded admin recipient for system.error notifications — role
    // membership isn't queryable from our DB today (roles are JWT-only
    // claims from Zitadel), so this is a deliberate placeholder until proper
    // admin-role resolution is built. Editable at any time; optional so a
    // tenant without one configured just gets no system.error recipients.
    SYSTEM_ADMIN_USER_ID: z.string().optional(),
    // Outbound handoff seam to the externally-owned email/SMS/WhatsApp
    // service. Contract is unresolved as of this feature — when unset, the
    // outbound worker logs and marks the notification 'sent' as a no-op
    // rather than retrying forever against a service that doesn't exist yet.
    NOTIFICATION_SERVICE_URL: z.string().url().optional(),
    // S2S auth for the outbound handoff (docs/notification-outbound-contract.md's
    // auth section) — a DEDICATED Zitadel machine user/key, deliberately
    // separate from ZITADEL_SERVICE_ACCOUNT_KEY/ZITADEL_KEY_JSON (which
    // authenticate as openwind-api-bot for Zitadel's own management API).
    // Never share this key with the outbound service — it only ever mints
    // tokens on our side; the outbound service verifies them via Zitadel's
    // public JWKS, it never needs the private key itself.
    NOTIFICATION_ZITADEL_KEY_JSON: z.string().optional(),
    // The dedicated Zitadel project ID the M2M token's `aud` claim must
    // contain (requested via scope urn:zitadel:iam:org:project:id:<id>:aud).
    // A project separate from the main app project, deliberately, so a
    // human end-user's own access token can never satisfy the outbound
    // service's audience check (see docs/notification-outbound-contract.md).
    NOTIFICATION_ZITADEL_AUDIENCE: z.string().optional(),
    S3_ENDPOINT: z.string().url(),
    // Public URL browsers use to reach MinIO. In Docker the internal endpoint is
    // http://minio:9000 but presigned URLs must resolve from the browser, so set
    // this to http://localhost:9000 (or the CDN/proxy URL in production).
    S3_PUBLIC_URL: z.string().url().optional(),
    S3_BUCKET: z.string(),
    S3_ACCESS_KEY: z.string(),
    S3_SECRET_KEY: z.string(),
    // Local-disk file storage (replaces presigned S3 URLs — see
    // docs/specs/local-disk-file-storage.md). In-container path only; the
    // host-side bind-mount source is FILES_STORAGE_PATH_HOST, a
    // docker-compose-only var never read by application code.
    FILES_STORAGE_PATH: z.string().default("/data/files"),
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
    // Set to "true" in dev when ClamAV is not running — files skip the queue and are marked clean immediately
    SKIP_AV_SCAN: z
      .string()
      .transform((v) => v === "true")
      .default("false"),
    // Secrets Provider: "openbao" for external vault, "local" for local AES-256-GCM encryption
    SECRETS_PROVIDER: z.enum(["openbao", "local"]).default("openbao"),
    // OpenBao — Transit envelope encryption for connector credentials
    OPENBAO_ADDR: z.string().url().optional(),
    OPENBAO_TRANSIT_KEY: z.string().default("platform-credentials"),
    // Dev: static root token. Prod: leave unset and use AppRole instead.
    OPENBAO_TOKEN: z.string().optional(),
    // AppRole auth (production) — both required together when OPENBAO_TOKEN is absent
    OPENBAO_ROLE_ID: z.string().optional(),
    OPENBAO_SECRET_ID: z.string().optional(),
    // Telemetry and Tracing (Stage 0)
    TELEMETRY_ENABLED: z
      .string()
      .transform((v) => v === "true")
      .default("false"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().optional(),
    METRICS_TOKEN: z.string().default("dev-metrics-token-12345"),
    OTEL_TRACE_SAMPLE_RATIO: z
      .string()
      .transform((v) => parseFloat(v))
      .default("0.01"),
    // Error Tracking (Stage 1)
    ERROR_TRACKING_PROVIDER: z
      .enum(["sentry", "glitchtip", "bugsink", "none"])
      .default("none"),
    SENTRY_DSN: z.string().url().optional(),
    // Trusted Proxies Configuration (e.g. "true", "false", or comma-separated IPs/CIDRs)
    TRUST_PROXY: z.string().default("false"),
    // Reporting — embedded Superset dashboards (3G Stage 1).
    // Two URLs are required, not one: inside a container `localhost` is that
    // container, so the browser-facing origin and the API→Superset origin are
    // never the same value in a real deployment. Validated as different in
    // production by a refine below.
    SUPERSET_SITE_URL: z.string().url().default("http://localhost:8088"),
    SUPERSET_INTERNAL_URL: z.string().url().default("http://superset:8088"),
    // Secrets: dev defaults exist so a fresh clone runs, and the refines below
    // reject every one of them in production. A usable default reaching a
    // deployment is the CVE-2023-27524 attack class (known signing key →
    // forged session), not a hygiene nit — see the reporting spec §P7.
    //
    // Never empty, in any environment: an empty value is not the dev default,
    // so without min(1) it would slip past the production guards below and hand
    // Superset an empty signing key. The 32-character floor for the two
    // signing keys is enforced in production only (refines below), so the
    // shorter dev defaults keep a fresh clone working.
    SUPERSET_SECRET_KEY: z.string().min(1).default(DEV_SUPERSET_SECRET_KEY),
    SUPERSET_GUEST_TOKEN_SECRET: z
      .string()
      .min(1)
      .default(DEV_SUPERSET_GUEST_TOKEN_SECRET),
    SUPERSET_SERVICE_ACCOUNT_USER: z.string().default("service_account"),
    SUPERSET_SERVICE_ACCOUNT_PASSWORD: z
      .string()
      .min(1)
      .default(DEV_SUPERSET_SERVICE_ACCOUNT_PASSWORD),
    SUPERSET_ADMIN_PASSWORD: z
      .string()
      .min(1)
      .default(DEV_SUPERSET_ADMIN_PASSWORD),
    // Dashboards are addressed by slug, never by UUID. The embedded UUID the
    // iframe needs is generated by Superset when embedding is enabled, so it
    // cannot be pinned here — the API resolves it from the slug at runtime.
    // A UUID literal in source would also break a fresh clone, where
    // provisioning generates different ones (spec R17).
    SUPERSET_DASHBOARD_TENANT_SLUG: z
      .string()
      .default("openwind-tenant-overview"),
    SUPERSET_DASHBOARD_USER_SLUG: z.string().default("openwind-my-performance"),
    // The Superset *connection* name our datasets live on. Needed because a
    // dataset is looked up by table name, and a table name alone is not unique
    // across connections — a stale connection carrying a same-named dataset
    // would make the lookup order-dependent. Must match bootstrap.py's
    // SUPERSET_REPORTING_DB_NAME.
    SUPERSET_REPORTING_DB_NAME: z.string().default("OpenWind Platform"),
  })
  .refine(
    (v) => v.ERROR_TRACKING_PROVIDER === "none" || v.SENTRY_DSN !== undefined,
    {
      message:
        "SENTRY_DSN is required when ERROR_TRACKING_PROVIDER is set to a provider",
    },
  )
  .refine(
    (v) => v.SECRETS_PROVIDER !== "openbao" || v.OPENBAO_ADDR !== undefined,
    {
      message: "OPENBAO_ADDR is required when SECRETS_PROVIDER is 'openbao'",
    },
  )
  .refine(
    (v) =>
      v.SECRETS_PROVIDER !== "openbao" ||
      v.OPENBAO_TOKEN !== undefined ||
      (v.OPENBAO_ROLE_ID !== undefined && v.OPENBAO_SECRET_ID !== undefined),
    {
      message:
        "Either OPENBAO_TOKEN (dev) or both OPENBAO_ROLE_ID and OPENBAO_SECRET_ID (prod) must be set for 'openbao' provider",
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
  })
  .refine((v) => !(v.NODE_ENV === "production" && v.SKIP_AV_SCAN), {
    message:
      "SKIP_AV_SCAN must not be true in production — it marks every upload clean without running antivirus scanning",
  })
  // Reporting (3G) — a development default reaching production means the guest
  // token signing key is public knowledge, so passes can be forged offline
  // without touching the deployment. Each secret is guarded separately so the
  // error names the one that is actually wrong.
  .refine(
    (v) =>
      !(
        v.NODE_ENV === "production" &&
        v.SUPERSET_SECRET_KEY === DEV_SUPERSET_SECRET_KEY
      ),
    {
      message:
        "SUPERSET_SECRET_KEY must not be its development default in production — a known Superset signing key forges an admin session (CVE-2023-27524 attack class)",
    },
  )
  .refine(
    (v) =>
      !(
        v.NODE_ENV === "production" &&
        v.SUPERSET_GUEST_TOKEN_SECRET === DEV_SUPERSET_GUEST_TOKEN_SECRET
      ),
    {
      message:
        "SUPERSET_GUEST_TOKEN_SECRET must not be its development default in production — a known guest-token key lets anyone mint a pass for any tenant offline",
    },
  )
  // Signing keys shorter than 32 characters are guessable offline, which is
  // the same forgery risk as a published default.
  .refine(
    (v) => !(v.NODE_ENV === "production" && v.SUPERSET_SECRET_KEY.length < 32),
    {
      message:
        "SUPERSET_SECRET_KEY must be at least 32 characters in production",
    },
  )
  .refine(
    (v) =>
      !(
        v.NODE_ENV === "production" && v.SUPERSET_GUEST_TOKEN_SECRET.length < 32
      ),
    {
      message:
        "SUPERSET_GUEST_TOKEN_SECRET must be at least 32 characters in production",
    },
  )
  .refine(
    (v) =>
      !(
        v.NODE_ENV === "production" &&
        v.SUPERSET_SERVICE_ACCOUNT_PASSWORD ===
          DEV_SUPERSET_SERVICE_ACCOUNT_PASSWORD
      ),
    {
      message:
        "SUPERSET_SERVICE_ACCOUNT_PASSWORD must not be its development default in production",
    },
  )
  .refine(
    (v) =>
      !(
        v.NODE_ENV === "production" &&
        v.SUPERSET_ADMIN_PASSWORD === DEV_SUPERSET_ADMIN_PASSWORD
      ),
    {
      message:
        "SUPERSET_ADMIN_PASSWORD must not be its development default in production",
    },
  )
  // R14: the two URLs address different networks — the browser cannot resolve a
  // docker service name, and inside a container `localhost` is that container.
  // Equal values in production mean one of the two is wrong, and the failure is
  // silent: the embed loads against the wrong origin instead of erroring.
  .refine(
    (v) =>
      !(
        v.NODE_ENV === "production" &&
        v.SUPERSET_SITE_URL === v.SUPERSET_INTERNAL_URL
      ),
    {
      message:
        "SUPERSET_SITE_URL and SUPERSET_INTERNAL_URL must differ in production — one is browser-facing, the other is the container-internal address",
    },
  );

export const env = EnvSchema.parse(process.env);

export type Env = z.infer<typeof EnvSchema>;
// Exported for env.test.ts — lets a default-value test
// parse a minimal env object directly instead of mutating process.env before
// this module's top-level `env.parse(process.env)` side effect has already run.
export { EnvSchema };

export interface PlanLimits {
  apiCallsPerDay: number;
  storageBytes: number;
  aiTokensPerDay: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  standard: {
    apiCallsPerDay: 10_000,
    storageBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    aiTokensPerDay: 50_000,
  },
  premium: {
    apiCallsPerDay: 100_000,
    storageBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    aiTokensPerDay: 500_000,
  },
  enterprise: {
    apiCallsPerDay: 1_000_000,
    storageBytes: 1000 * 1024 * 1024 * 1024, // 1 TB
    aiTokensPerDay: 5_000_000,
  },
};
