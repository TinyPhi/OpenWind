// Checks the rendered production compose config before `up` (ADR-023 Decision 1):
//
//   pnpm --filter @platform/openbao-deploy check:prod-compose
//
// It renders docker-compose.yml + docker-compose.prod.yml with
// `--no-interpolate --no-env-resolution` and inspects the result in memory.
// It prints only service and key names, never a value: plain `config` prints
// every resolved value, and even these flags still print values written
// directly in a compose file.
//
// It fails when:
//   - the dev OpenBao (`openbao`, `openbao-init`) would start (for example
//     because COMPOSE_PROFILES activates its profile);
//   - any service reads `.env.local` (env_file or volume source);
//   - any `environment:` key is not on that service's allowlist below — the
//     allowlist IS the definition of non-secret wiring (ADR-023 OQ-1);
//   - a secret-holding service doesn't start through the OpenBao loader, or
//     lacks the loader's settings.
// A standalone CLI like packages/db's scripts: it reads COMPOSE_PROFILES the
// same way Docker Compose does, so direct process.env access is intentional.
/* eslint-disable no-restricted-syntax */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

type ComposePort =
  | string
  | { host_ip?: string; published?: string | number; target?: number };

interface ComposeService {
  profiles?: string[] | null;
  ports?: ComposePort[] | null;
  image?: string | null;
  build?: { args?: Record<string, string> | null } | null;
  entrypoint?: string[] | string | null;
  environment?: Record<string, unknown> | string[] | null;
  env_file?: { path?: string }[] | null;
  volumes?: { source?: string; target?: string }[] | null;
}

export interface ComposeConfig {
  services?: Record<string, ComposeService>;
}

const LOADER_ENV = [
  "OPENBAO_ADDR",
  "OPENBAO_NETWORK_CIDR",
  "NODE_ENV",
  "BAO_KV_PATH",
  "BAO_REQUIRED_KEYS",
] as const;

// Every environment key compose may set, per service. Anything else is
// treated as a secret that belongs in OpenBao.
export const ALLOWED_ENV: Record<string, readonly string[]> = {
  postgres: ["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_INITDB_ARGS"],
  pgbouncer: [
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "POOL_MODE",
    "MAX_CLIENT_CONN",
    "DEFAULT_POOL_SIZE",
    "AUTH_TYPE",
    "SERVER_TLS_SSLMODE",
  ],
  redis: [],
  clamav: [],
  "ow-backend": [
    ...LOADER_ENV,
    "BAO_KEEP_LOGIN",
    "OPENBAO_TRANSIT_KEY",
    "REDIS_URL",
    "ZITADEL_JWKS_URL",
    "ZITADEL_INTROSPECTION_URL",
    "SUPERSET_SITE_URL",
    "SUPERSET_INTERNAL_URL",
    "SUPERSET_DASHBOARD_TENANT_SLUG",
    "SUPERSET_DASHBOARD_USER_SLUG",
    "SUPERSET_SERVICE_ACCOUNT_USER",
    "FILES_STORAGE_PATH",
  ],
  "ow-worker": [
    ...LOADER_ENV,
    "BAO_KEEP_LOGIN",
    "OPENBAO_TRANSIT_KEY",
    "REDIS_URL",
    "ZITADEL_JWKS_URL",
    "ZITADEL_INTROSPECTION_URL",
    "FILES_STORAGE_PATH",
    "CLAMAV_HOST",
    "CLAMAV_PORT",
  ],
  "ow-frontend": [
    "VITE_API_PROXY_TARGET",
    "ZITADEL_ISSUER",
    "ZITADEL_OIDC_CLIENT_ID",
    "VITE_IDLE_LOGOUT_ENABLED",
  ],
  bootstrap: [
    ...LOADER_ENV,
    "RUNNING_IN_DOCKER",
    "REDIS_URL",
    "ZITADEL_EXTERNAL_DOMAIN",
    "ZITADEL_HOST_PORT",
    "ZITADEL_EXTERNALSECURE",
    "APP_URL",
    "BOOTSTRAP_SECRETS_OUT",
  ],
  superset: [
    ...LOADER_ENV,
    "SUPERSET_CONFIG_PATH",
    "SERVER_WORKER_AMOUNT",
    "GUNICORN_TIMEOUT",
    "REDIS_URL",
    "SUPERSET_OAUTH_ISSUER",
    "SUPERSET_SESSION_MAX_MINUTES",
    "SUPERSET_REPORTING_DB_NAME",
  ],
  "superset-init": [
    ...LOADER_ENV,
    "SUPERSET_CONFIG_PATH",
    "SUPERSET_SERVICE_ACCOUNT_USER",
    "SUPERSET_DASHBOARD_TENANT_SLUG",
    "SUPERSET_DASHBOARD_USER_SLUG",
    "SUPERSET_EMBED_ORIGIN",
    "REDIS_URL",
  ],
  "novu-api": [
    ...LOADER_ENV,
    "MONGO_URL",
    "REDIS_HOST",
    "REDIS_PORT",
    "API_ROOT_URL",
    "FRONT_BASE_URL",
  ],
  "novu-worker": [...LOADER_ENV, "MONGO_URL", "REDIS_HOST", "REDIS_PORT"],
  "novu-web": ["REACT_APP_API_URL"],
  "novu-mongo": [],
};

// Services whose secrets come from OpenBao through the startup loader.
export const LOADER_SERVICES = [
  "ow-backend",
  "ow-worker",
  "bootstrap",
  "superset",
  "superset-init",
  "novu-api",
  "novu-worker",
] as const;

const DEV_OPENBAO = ["openbao", "openbao-init"];

// Services the production override rebuilds FROM a pinned third-party image
// (ADR-023): the NOVU_IMAGE build argument must equal the base file's image.
const REBUILT_FROM_BASE = ["novu-api", "novu-worker"];

export interface CheckOptions {
  /** docker-compose.yml rendered on its own, for the pinned-image comparison. */
  base?: ComposeConfig;
  /** What a host path is; defaults to the real filesystem. */
  pathKind?: (path: string) => "file" | "directory" | "missing";
}

function realPathKind(path: string): "file" | "directory" | "missing" {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

// Production publishes nothing on every interface: the reverse proxy on the
// host reaches services over loopback. A port written with a variable stays a
// string in the uninterpolated render, so both forms are read.
function isLoopbackPort(port: ComposePort): boolean {
  if (typeof port === "string") {
    return /^(127\.0\.0\.1|\[::1\]|localhost):/.test(port);
  }
  return port.host_ip !== undefined && LOOPBACK.includes(port.host_ip);
}

function describePort(port: ComposePort): string {
  return typeof port === "string"
    ? port
    : `${port.published ?? "?"}:${port.target ?? "?"}`;
}

// `environment:` can be a map or a list of "KEY=value" strings; only the
// names matter here.
function envKeys(env: ComposeService["environment"]): string[] {
  if (!env) return [];
  if (Array.isArray(env))
    return env.map((entry) => entry.split("=")[0] ?? entry);
  return Object.keys(env);
}

function isEnvLocal(path: string | undefined): boolean {
  return (
    path !== undefined && basename(path.replace(/\\/g, "/")) === ".env.local"
  );
}

// `--no-interpolate` makes Compose render every service regardless of
// profiles, so the active profiles are applied here.
function activeServices(
  config: ComposeConfig,
  profiles: readonly string[],
): Record<string, ComposeService> {
  const active = new Set(profiles);
  return Object.fromEntries(
    Object.entries(config.services ?? {}).filter(([, service]) => {
      const own = service.profiles ?? [];
      return own.length === 0 || own.some((p) => active.has(p));
    }),
  );
}

export function checkComposeConfig(
  config: ComposeConfig,
  profiles: readonly string[] = [],
  options: CheckOptions = {},
): string[] {
  const problems: string[] = [];
  const services = activeServices(config, profiles);
  const pathKind = options.pathKind ?? realPathKind;

  for (const name of DEV_OPENBAO) {
    if (name in services) {
      problems.push(
        `${name}: the dev OpenBao would start (check COMPOSE_PROFILES / --profile)`,
      );
    }
  }

  for (const [name, service] of Object.entries(services)) {
    if (DEV_OPENBAO.includes(name)) continue;

    for (const file of service.env_file ?? []) {
      if (isEnvLocal(file.path)) {
        problems.push(`${name}: reads .env.local through env_file`);
      }
    }
    for (const volume of service.volumes ?? []) {
      if (isEnvLocal(volume.source)) {
        problems.push(
          `${name}: mounts .env.local into ${volume.target ?? "?"}`,
        );
      }
      // The override hides .env.local by mounting an empty file over it. If
      // that file is missing, Docker mounts a directory instead; fail rather
      // than rely on what Vite does then.
      if (isEnvLocal(volume.target) && volume.source) {
        const kind = pathKind(volume.source);
        if (kind !== "file") {
          problems.push(
            `${name}: the file mounted over ${volume.target} is ${kind === "missing" ? "missing" : "a directory"}`,
          );
        }
      }
    }

    const open = (service.ports ?? []).filter((port) => !isLoopbackPort(port));
    if (open.length > 0) {
      problems.push(
        `${name}: ports published on every interface (bind them to 127.0.0.1): ${open.map(describePort).join(", ")}`,
      );
    }

    const allowed = new Set(ALLOWED_ENV[name] ?? []);
    const keys = envKeys(service.environment);
    const unexpected = keys.filter((key) => !allowed.has(key)).sort();
    if (unexpected.length > 0) {
      const why =
        name in ALLOWED_ENV
          ? "not on the non-secret allowlist"
          : "service not reviewed for production";
      problems.push(
        `${name}: environment keys ${why}: ${unexpected.join(", ")}`,
      );
    }
  }

  for (const name of LOADER_SERVICES) {
    const service = services[name];
    if (!service) continue; // profile not active
    const entrypoint = [service.entrypoint ?? []].flat().join(" ");
    if (!entrypoint.includes("bao-env-loader")) {
      problems.push(`${name}: does not start through the OpenBao loader`);
    }
    const env = new Set(envKeys(service.environment));
    const missing = [
      "OPENBAO_ADDR",
      "OPENBAO_NETWORK_CIDR",
      "BAO_KV_PATH",
    ].filter((key) => !env.has(key));
    if (missing.length > 0) {
      problems.push(`${name}: loader settings missing: ${missing.join(", ")}`);
    }
  }

  if (options.base) {
    for (const name of REBUILT_FROM_BASE) {
      const service = services[name];
      if (!service) continue;
      const pinned = options.base.services?.[name]?.image ?? undefined;
      const built = service.build?.args?.["NOVU_IMAGE"] ?? undefined;
      if (!built || built !== pinned) {
        problems.push(
          `${name}: build arg NOVU_IMAGE does not match the image pinned in docker-compose.yml`,
        );
      }
    }
  }

  return problems;
}

// Same sources as Docker Compose: the COMPOSE_PROFILES variable, else the
// project's .env file.
function composeProfiles(repoRoot: string): string[] {
  let raw = process.env["COMPOSE_PROFILES"];
  const envFile = resolve(repoRoot, ".env");
  if (raw === undefined && existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith("COMPOSE_PROFILES="));
    raw = line?.slice("COMPOSE_PROFILES=".length);
  }
  return (raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// Renders without interpolation, so the output can't contain resolved values.
function render(repoRoot: string, files: string[]): ComposeConfig | string {
  const res = spawnSync(
    "docker",
    [
      "compose",
      ...files.flatMap((f) => ["-f", f]),
      "config",
      "--format",
      "json",
      "--no-interpolate",
      "--no-env-resolution",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Compose's own error names the problem; it never contains values here
  // because nothing was interpolated.
  if (res.status !== 0) return res.stderr;
  return JSON.parse(res.stdout) as ComposeConfig;
}

function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const prod = render(repoRoot, [
    "docker-compose.yml",
    "docker-compose.prod.yml",
  ]);
  const base = render(repoRoot, ["docker-compose.yml"]);
  if (typeof prod === "string" || typeof base === "string") {
    console.error(
      `docker compose config failed:\n${typeof prod === "string" ? prod : base}`,
    );
    return 2;
  }

  const profiles = composeProfiles(repoRoot);
  const problems = checkComposeConfig(prod, profiles, { base });
  if (problems.length === 0) {
    console.error(
      `OK: production compose config passes the ADR-023 checks (profiles: ${profiles.join(",") || "none"}).`,
    );
    return 0;
  }
  for (const problem of problems) console.error(`FAIL ${problem}`);
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
