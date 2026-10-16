import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkComposeConfig,
  ALLOWED_ENV,
  type ComposeConfig,
} from "./check-prod-compose.js";

const LOADER = ["node", "/app/packages/openbao-deploy/src/bao-env-loader.mjs"];
const LOADER_SETTINGS = {
  OPENBAO_ADDR: "x",
  OPENBAO_NETWORK_CIDR: "x",
  BAO_KV_PATH: "x",
};

const FILES_OK = { pathKind: () => "file" as const };

function valid(): ComposeConfig {
  return {
    services: {
      redis: {},
      "ow-backend": {
        entrypoint: LOADER,
        environment: { ...LOADER_SETTINGS, REDIS_URL: "redis://redis:6379" },
        env_file: [{ path: "/srv/secrets/backend.env" }],
        volumes: [{ source: "/srv/files", target: "/data/files" }],
      },
      "ow-frontend": {
        environment: { ZITADEL_ISSUER: "x" },
        volumes: [
          {
            source: "./packages/openbao-deploy/empty.env",
            target: "/app/.env.local",
          },
        ],
      },
    },
  };
}

describe("checkComposeConfig", () => {
  it("accepts a config that keeps to the rules", () => {
    expect(checkComposeConfig(valid(), [], FILES_OK)).toEqual([]);
  });

  it("fails when the dev OpenBao would start", () => {
    const cfg = valid();
    cfg.services!["openbao"] = {};
    expect(checkComposeConfig(cfg, [], FILES_OK)).toEqual([
      expect.stringContaining("openbao: the dev OpenBao would start"),
    ]);
  });

  it("fails on a key outside the allowlist, naming the key but not its value", () => {
    const cfg = valid();
    (cfg.services!["ow-backend"]!.environment as Record<string, unknown>)[
      "DATABASE_URL"
    ] = "postgres://u:SECRET@db/x";
    const problems = checkComposeConfig(cfg, [], FILES_OK);
    expect(problems).toEqual([expect.stringContaining("DATABASE_URL")]);
    expect(problems.join(" ")).not.toContain("SECRET");
  });

  it("fails on a service nobody reviewed for production", () => {
    const cfg = valid();
    cfg.services!["grafana"] = {
      environment: { GF_SECURITY_ADMIN_PASSWORD: "x" },
    };
    expect(checkComposeConfig(cfg, [], FILES_OK)).toEqual([
      expect.stringContaining("grafana: environment keys service not reviewed"),
    ]);
  });

  it("fails when a service reads .env.local", () => {
    const cfg = valid();
    cfg.services!["ow-backend"]!.env_file = [{ path: "./.env.local" }];
    cfg.services!["ow-frontend"]!.volumes = [
      { source: "C:\\repo\\.env.local", target: "/app/.env.local" },
    ];
    const problems = checkComposeConfig(cfg, [], FILES_OK);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/ow-backend: reads \.env\.local/);
    expect(problems.join("\n")).toMatch(/ow-frontend: mounts \.env\.local/);
  });

  it("fails when a secret-holding service skips the loader or its settings", () => {
    const cfg = valid();
    cfg.services!["ow-backend"]!.entrypoint = null;
    delete (
      cfg.services!["ow-backend"]!.environment as Record<string, unknown>
    )["OPENBAO_NETWORK_CIDR"];
    const problems = checkComposeConfig(cfg, [], FILES_OK).join("\n");
    expect(problems).toMatch(
      /ow-backend: does not start through the OpenBao loader/,
    );
    expect(problems).toMatch(
      /ow-backend: loader settings missing: OPENBAO_NETWORK_CIDR/,
    );
  });
});

describe("checkComposeConfig — mounted file and pinned images", () => {
  it("fails when the file hiding .env.local is missing or a directory", () => {
    for (const kind of ["missing", "directory"] as const) {
      expect(
        checkComposeConfig(valid(), [], { pathKind: () => kind }).join("\n"),
      ).toMatch(/ow-frontend: the file mounted over \/app\/\.env\.local is/);
    }
  });

  function withNovu(builtFrom: string | undefined): ComposeConfig {
    const cfg = valid();
    cfg.services!["novu-api"] = {
      entrypoint: LOADER,
      environment: { ...LOADER_SETTINGS },
      build: { args: builtFrom ? { NOVU_IMAGE: builtFrom } : {} },
    };
    return cfg;
  }
  const base: ComposeConfig = {
    services: { "novu-api": { image: "ghcr.io/novuhq/novu/api@sha256:aaa" } },
  };

  it("accepts a Novu image rebuilt from the base file's pinned digest", () => {
    expect(
      checkComposeConfig(withNovu("ghcr.io/novuhq/novu/api@sha256:aaa"), [], {
        ...FILES_OK,
        base,
      }),
    ).toEqual([]);
  });

  it("fails when the digests drift apart", () => {
    expect(
      checkComposeConfig(withNovu("ghcr.io/novuhq/novu/api@sha256:bbb"), [], {
        ...FILES_OK,
        base,
      }),
    ).toEqual([
      expect.stringContaining("novu-api: build arg NOVU_IMAGE does not match"),
    ]);
  });
});

describe("checkComposeConfig — published ports", () => {
  it("accepts ports bound to loopback, in both rendered forms", () => {
    const cfg = valid();
    cfg.services!["ow-backend"]!.ports = [
      "127.0.0.1:${API_HOST_PORT:-3002}:3000",
      { host_ip: "127.0.0.1", published: "4317", target: 4317 },
    ];
    expect(checkComposeConfig(cfg, [], FILES_OK)).toEqual([]);
  });

  it("fails on a port published on every interface, in both rendered forms", () => {
    const cfg = valid();
    cfg.services!["ow-frontend"]!.ports = ["${ADMIN_UI_HOST_PORT:-3001}:3001"];
    cfg.services!["redis"]!.ports = [{ published: "3010", target: 3000 }];
    const problems = checkComposeConfig(cfg, [], FILES_OK).join("\n");
    expect(problems).toMatch(/ow-frontend: ports published on every interface/);
    expect(problems).toMatch(
      /redis: ports published on every interface .*3010:3000/,
    );
  });

  it("reads list-form environment by key name", () => {
    const cfg = valid();
    cfg.services!["ow-frontend"]!.environment = [
      "ZITADEL_ISSUER=x",
      "SECRET_THING=y",
    ];
    expect(checkComposeConfig(cfg, [], FILES_OK).join("\n")).toMatch(
      /ow-frontend: environment keys not on the non-secret allowlist: SECRET_THING/,
    );
  });
});

// The real files, rendered by Docker Compose (no daemon needed for `config`).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hasCompose =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status ===
  0;

function render(
  files = ["docker-compose.yml", "docker-compose.prod.yml"],
): ComposeConfig {
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
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (res.status !== 0) throw new Error(res.stderr);
  return JSON.parse(res.stdout) as ComposeConfig;
}

describe.skipIf(!hasCompose)("docker-compose.prod.yml", () => {
  const withBase = () => ({ base: render(["docker-compose.yml"]) });

  it("passes with the production profiles", () => {
    expect(
      checkComposeConfig(render(), ["reporting", "bootstrap"], withBase()),
    ).toEqual([]);
  });

  it("has an allowlist entry for every service it starts", () => {
    const all = render().services ?? {};
    const started = Object.entries(all)
      .filter(
        ([, s]) =>
          !s.profiles?.length ||
          s.profiles.some((p) => ["reporting", "bootstrap"].includes(p)),
      )
      .map(([name]) => name);
    for (const name of started) expect(ALLOWED_ENV).toHaveProperty([name]);
  });

  it("fails if a profile re-enables the dev OpenBao", () => {
    expect(
      checkComposeConfig(
        render(),
        ["reporting", "openbao-dev-disabled"],
        withBase(),
      ).join("\n"),
    ).toMatch(/the dev OpenBao would start/);
  });

  it("passes with Novu enabled: its secrets come from OpenBao", () => {
    expect(
      checkComposeConfig(
        render(),
        ["reporting", "bootstrap", "notifications"],
        withBase(),
      ),
    ).toEqual([]);
  });

  it("still flags a profile nobody reviewed (observability)", () => {
    expect(
      checkComposeConfig(
        render(),
        ["reporting", "observability"],
        withBase(),
      ).join("\n"),
    ).toMatch(/grafana: environment keys service not reviewed/);
  });
});
