/**
 * Architectural guard for ADR-012 Phase A spec R1: "Key minting is human-only,
 * admin-role-gated" — specifically "No background job, worker, or automation
 * can mint a key." That property isn't something a request-level test can
 * exercise (there's no code path to call); it only holds because no such
 * code path exists today. This test makes that fact self-enforcing: it fails
 * the moment a new `.insert(apiKeys)` call appears anywhere outside the
 * three known, already-admin-gated key-issuing routes, or if one of those
 * three routes ever loses its `requireRole("admin")` gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

// The only endpoints allowed to ever create a fresh api_keys row with a real
// key hash. Every one of them requires requireRole("admin") — a key can only
// ever come into existence via an explicit admin action, never a scheduled
// job, webhook handler, or automation step.
const ALLOWED_MINTERS = [
  "apps/api/src/routes/api-keys/create.ts",
  "apps/api/src/routes/api-keys/rotate.ts",
  "apps/api/src/routes/api-keys/emergency-rotate.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("api_keys mint-path guard (ADR-012 Phase A spec R1)", () => {
  it("only the known, admin-gated key-issuing routes ever call apiKeys.insert()", () => {
    const searchRoots = ["apps/api/src", "apps/worker/src", "packages"].map(
      (p) => join(REPO_ROOT, p),
    );
    const insertingFiles: string[] = [];
    for (const root of searchRoots) {
      for (const file of walk(root)) {
        const contents = readFileSync(file, "utf8");
        if (/\.insert\(apiKeys\)/.test(contents)) {
          insertingFiles.push(relative(REPO_ROOT, file).replace(/\\/g, "/"));
        }
      }
    }
    expect(insertingFiles.sort()).toEqual(ALLOWED_MINTERS.slice().sort());
  });

  it("every known key-issuing route requires the admin role", () => {
    for (const relPath of ALLOWED_MINTERS) {
      const contents = readFileSync(join(REPO_ROOT, relPath), "utf8");
      expect(contents).toMatch(/requireRole\(\s*"admin"\s*\)/);
    }
  });
});
