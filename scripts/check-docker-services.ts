/**
 * Checks that the required Docker Compose services are running before tests that
 * need a live stack. Accepts service names as positional CLI arguments.
 *
 * Usage: tsx scripts/check-docker-services.ts postgres redis openbao
 *
 * Platform notes:
 *   macOS  — use OrbStack (lighter than Docker Desktop, same socket)
 *   Windows — Docker is slow; run these tests in CI or WSL2
 *   Linux  — docker compose up -d
 */

import { execSync } from "child_process";

const required = process.argv.slice(2);

if (required.length === 0) {
  console.error("check-docker-services: no service names provided");
  process.exit(1);
}

function platformHint(): string {
  if (process.platform === "darwin") {
    return "  On macOS: open OrbStack, then run: docker compose up -d";
  }
  if (process.platform === "win32") {
    return "  On Windows: these tests are best run in CI or WSL2 (Docker on Windows is slow).\n  If you have WSL2 + Docker: run `docker compose up -d` from the WSL shell.";
  }
  return "  Run: docker compose up -d";
}

// 1. Check the Docker daemon is reachable at all.
try {
  execSync("docker info", { stdio: "ignore", timeout: 5000 });
} catch {
  console.error("\n❌  Docker / OrbStack is not running.\n");
  console.error(platformHint());
  console.error("");
  process.exit(1);
}

// 2. Ask Compose which services are currently in a running state.
let running: string[];
try {
  const raw = execSync("docker compose ps --services --filter status=running", {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 15000,
  });
  running = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  console.error("\n❌  Could not query docker compose services.");
  console.error("  Make sure docker-compose.yml is present and readable.\n");
  process.exit(1);
}

// 3. Report anything missing.
const missing = required.filter((s) => !running.includes(s));

if (missing.length > 0) {
  console.error(
    `\n❌  Required service${missing.length > 1 ? "s" : ""} not running: ${missing.join(", ")}\n`,
  );
  console.error(platformHint());
  console.error("");
  process.exit(1);
}
