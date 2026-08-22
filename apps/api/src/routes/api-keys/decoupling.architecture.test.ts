/**
 * Architectural guards to prevent tight coupling to Zitadel (identity provider)
 * and OpenBao (secrets vault) from creeping back into the codebase.
 *
 * This test enforces that:
 * 1. Zitadel-specific DB column naming (zitadel_client_id, etc.) remains decoupled and
 *    represented generically as OIDC Client ID.
 * 2. No packages other than @platform/secrets, @platform/config, and bootstrap scripts
 *    access OPENBAO_* configuration or direct OpenBao APIs, ensuring secrets storage decoupling.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
        // Only packages/secrets and packages/config are allowed to know about OpenBao
        if (
          rel.includes("packages/secrets") ||
          rel.includes("packages/config")
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
});
