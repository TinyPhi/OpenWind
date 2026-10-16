/**
 * Architectural guards to prevent tight coupling to Zitadel (identity provider)
 * and OpenBao (secrets vault) from creeping back into the codebase.
 *
 * This test enforces that:
 * 1. Zitadel-specific DB column naming (zitadel_client_id, etc.) remains decoupled and
 *    represented generically as OIDC Client ID.
 * 2. No packages other than @platform/secrets, @platform/config, @platform/openbao-deploy
 *    (container entrypoint loaders and the production compose check) and bootstrap scripts
 *    access OPENBAO_* configuration or direct OpenBao APIs, ensuring secrets storage decoupling.
 *    Nothing may depend on @platform/openbao-deploy, so that exemption stays deploy-only.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === ".turbo" ||
      entry === "migrations"
    ) {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith("config.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("architectural decoupling guards", () => {
  it("enforces that database column and API queries remain decoupled from Zitadel naming", () => {
    const searchRoots = ["apps/api/src", "apps/worker/src", "packages"].map(
      (p) => join(REPO_ROOT, p),
    );

    const violations: string[] = [];
    for (const root of searchRoots) {
      for (const file of walk(root)) {
        const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
        // Skip Zitadel management API integration and config definitions which intentionally talk to Zitadel
        if (
          rel.includes("zitadel-management") ||
          rel.includes("packages/config") ||
          rel.includes("setup-dev-auth")
        ) {
          continue;
        }

        const contents = readFileSync(file, "utf8");
        if (
          /zitadel_client_id/i.test(contents) ||
          /zitadelClientId/i.test(contents)
        ) {
          violations.push(rel);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("enforces that secrets storage remains decoupled from OpenBao", () => {
    const searchRoots = ["apps/api/src", "apps/worker/src", "packages"].map(
      (p) => join(REPO_ROOT, p),
    );

    const violations: string[] = [];
    for (const root of searchRoots) {
      for (const file of walk(root)) {
        const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
        // Only packages/secrets and packages/config are allowed to know about OpenBao,
        // plus packages/openbao-deploy: OpenBao-specific deploy tooling that no other
        // package may depend on (checked by the next test).
        if (
          rel.includes("packages/secrets") ||
          rel.includes("packages/config") ||
          rel.startsWith("packages/openbao-deploy/")
        ) {
          continue;
        }

        const contents = readFileSync(file, "utf8");
        if (/OPENBAO_/i.test(contents) || /openbaoRequest/i.test(contents)) {
          violations.push(rel);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps @platform/openbao-deploy out of every other package's dependencies", () => {
    const dependents: string[] = [];
    for (const base of ["apps", "packages", "modules"]) {
      for (const entry of readdirSync(join(REPO_ROOT, base))) {
        const manifest = join(REPO_ROOT, base, entry, "package.json");
        if (!existsSync(manifest)) continue;
        const rel = relative(REPO_ROOT, manifest).replace(/\\/g, "/");
        if (rel === "packages/openbao-deploy/package.json") continue;
        if (
          readFileSync(manifest, "utf8").includes('"@platform/openbao-deploy"')
        ) {
          dependents.push(rel);
        }
      }
    }

    expect(dependents).toEqual([]);
  });
});
