#!/usr/bin/env tsx
/**
 * dev-reset.ts — confirmed, full local-dev reset (#202).
 *
 * `docker compose down` (keeps volumes) and `docker compose down -v` (wipes
 * them) are easy to confuse — picking the wrong one either leaves stale
 * containers around or silently deletes all local Postgres/MinIO/etc. data.
 * This wraps the destructive path behind an intent-revealing name and a
 * confirmation prompt, and always wipes BOTH the openwind and zitadel
 * volumes together: wiping only one side leaves a stale OIDC client secret
 * that no longer matches the other side's fresh bootstrap, breaking login
 * (see the "Resetting everything" section of docs/local-setup.md).
 *
 * TypeScript rather than bash (PR #318 review) so it runs natively on
 * Windows — this repo also ships setup.bat/setup.ps1 — without requiring a
 * bash shell on PATH.
 *
 * Run:
 *   pnpm dev:reset
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const OW_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
// Reviewer suggestion (PR #318): allow overriding the sibling zitadel
// checkout's location instead of always assuming ../zitadel.
const ZITA_DIR = process.env["ZITADEL_DIR"] ?? join(dirname(OW_DIR), "zitadel");

function run(cmd: string, cwd: string): void {
  const result = spawnSync(cmd, { shell: true, cwd, stdio: "inherit" });
  if ((result.status ?? 1) !== 0) {
    console.error(`Command failed: ${cmd}`);
    process.exit(result.status ?? 1);
  }
}

async function confirm(): Promise<boolean> {
  // Refuse rather than hang waiting for input that will never arrive (CI, a
  // git hook, or any non-interactive/piped invocation) — PR #318 review.
  if (!process.stdin.isTTY) {
    console.error(
      "dev:reset needs an interactive terminal to confirm this destructive " +
        "action — refusing to run non-interactively (CI, a hook, or piped stdin).",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Type 'reset' to continue: ", resolve);
  });
  rl.close();
  return answer === "reset";
}

async function main(): Promise<void> {
  console.log(
    "This will stop containers and DELETE all local Postgres/Redis/MinIO/OpenBao",
  );
  console.log(
    "data for this checkout (and its Zitadel instance), then remove .env.local.",
  );
  console.log(
    "Use 'pnpm dev:down' instead if you just want to stop containers and keep your data.",
  );
  console.log();

  if (!(await confirm())) {
    console.error("Aborted — nothing was deleted.");
    process.exit(1);
  }

  run("docker compose down -v", OW_DIR);

  if (existsSync(ZITA_DIR)) {
    run("docker compose down -v", ZITA_DIR);
  } else {
    console.log(
      `Note: ${ZITA_DIR} not found — skipping (nothing to wipe there).`,
    );
  }

  rmSync(join(OW_DIR, ".env.local"), { force: true });

  console.log();
  console.log(
    "Reset complete. Run ./setup.sh (or setup.bat) again for a fresh environment.",
  );
}

void main();
