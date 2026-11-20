import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * What the compose files do to Superset's container logs (#1140, ADR-019 process-log attestation,
 * docs/runbooks/superset-erasure.md "Process logs"): rotate them by size, and keep the query
 * string out of the gunicorn access log. These live here, not in docker/superset, because the
 * built-image Python harness mounts only docker/superset and cannot read the compose files.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (name: string): string => readFileSync(`${ROOT}${name}`, "utf8");

/** The text of the `superset:` service, up to the next service. */
function supersetBlock(compose: string): string {
  const match = /^ {2}superset:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9-]*:\n)/m.exec(
    compose,
  );
  if (!match?.[1]) throw new Error("no superset service found");
  return match[1];
}

const ACCESS_LOG_FORMAT = "%(m)s %(U)s %(s)s %(D)s";
const base = supersetBlock(read("docker-compose.yml"));
const prod = supersetBlock(read("docker-compose.prod.yml"));

describe("Superset container logs (#1140)", () => {
  it("are rotated by size, so their volume is bounded", () => {
    expect(base).toMatch(/logging:\n\s+driver: json-file/);
    expect(base).toMatch(/max-size: "10m"/);
    expect(base).toMatch(/max-file: "5"/);
  });

  it("keep the base logging options in prod: the override file does not replace `logging`", () => {
    // docker-compose.prod.yml overrides `environment` and `networks` wholesale but not `logging`,
    // so a `logging:` there would silently replace the base options.
    expect(prod).not.toMatch(/^ {4}logging:/m);
  });

  it.each([
    ["docker-compose.yml", base],
    ["docker-compose.prod.yml", prod],
  ])(
    "%s keeps the query string out of the gunicorn access log",
    (_file, block) => {
      // The prod file replaces `environment` with `!override`, so each file has to set it.
      const match = /GUNICORN_CMD_ARGS: "(.*)"/.exec(block);
      expect(match?.[1]).toBeDefined();
      const args = match?.[1] ?? "";
      expect(args).toContain(`--access-logformat '${ACCESS_LOG_FORMAT}'`);
      for (const field of [
        "%(q)s",
        "%(r)s",
        "%(f)s",
        "%(a)s",
        "%(h)s",
        "%(u)s",
        "%(l)s",
      ]) {
        expect(args).not.toContain(field);
      }
    },
  );
});
