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
    expect(checkComposeConfig(valid())).toEqual([]);
  });

  it("fails when the dev OpenBao would start", () => {
    const cfg = valid();
    cfg.services!["openbao"] = {};
    expect(checkComposeConfig(cfg)).toEqual([
      expect.stringContaining("openbao: the dev OpenBao would start"),
    ]);
  });

  it("fails on a key outside the allowlist, naming the key but not its value", () => {
    const cfg = valid();
    cfg.services!["ow-backend"]!.environment!["DATABASE_URL"] =
      "postgres://u:SECRET@db/x";
    const problems = checkComposeConfig(cfg);
    expect(problems).toEqual([expect.stringContaining("DATABASE_URL")]);
    expect(problems.join(" ")).not.toContain("SECRET");
  });

  it("fails on a service nobody reviewed for production", () => {
    const cfg = valid();
    cfg.services!["grafana"] = {
      environment: { GF_SECURITY_ADMIN_PASSWORD: "x" },
    };
    expect(checkComposeConfig(cfg)).toEqual([
      expect.stringContaining("grafana: environment keys service not reviewed"),
    ]);
  });

  it("fails when a service reads .env.local", () => {
    const cfg = valid();
    cfg.services!["ow-backend"]!.env_file = [{ path: "./.env.local" }];
    cfg.services!["ow-frontend"]!.volumes = [
      { source: "C:\\repo\\.env.local", target: "/app/.env.local" },
    ];
    const problems = checkComposeConfig(cfg);
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toMatch(/ow-backend: reads \.env\.local/);
    expect(problems.join("\n")).toMatch(/ow-frontend: mounts \.env\.local/);
  });

  it("fails when a secret-holding service skips the loader or its settings", () => {
    const cfg = valid();
    cfg.services!["ow-backend"]!.entrypoint = null;
    delete cfg.services!["ow-backend"]!.environment!["OPENBAO_NETWORK_CIDR"];
    const problems = checkComposeConfig(cfg).join("\n");
    expect(problems).toMatch(
      /ow-backend: does not start through the OpenBao loader/,
    );
    expect(problems).toMatch(
      /ow-backend: loader settings missing: OPENBAO_NETWORK_CIDR/,
    );
  });
});

// The real files, rendered by Docker Compose (no daemon needed for `config`).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hasCompose =
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status ===
  0;

function render(): ComposeConfig {
  const res = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.prod.yml",
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
  it("passes with the production profiles", () => {
    expect(checkComposeConfig(render(), ["reporting", "bootstrap"])).toEqual(
      [],
    );
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
      checkComposeConfig(render(), ["reporting", "openbao-dev-disabled"]).join(
        "\n",
      ),
    ).toMatch(/the dev OpenBao would start/);
  });

  it("passes with Novu enabled: its secrets come from OpenBao", () => {
    expect(
      checkComposeConfig(render(), ["reporting", "bootstrap", "notifications"]),
    ).toEqual([]);
  });

  it("still flags a profile nobody reviewed (observability)", () => {
    expect(
      checkComposeConfig(render(), ["reporting", "observability"]).join("\n"),
    ).toMatch(/grafana: environment keys service not reviewed/);
  });
});
