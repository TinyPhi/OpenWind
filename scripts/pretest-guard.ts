/**
 * Thin wrapper extracted from the inline `node -e` strings that used to live
 * directly in package.json's pretest:* scripts (issue #110) — editing the
 * service list or script path there required careful shell-escaping and was
 * error-prone in diffs. Skips the Docker pre-check entirely in CI (the real
 * services are provided by the CI job itself, not docker compose).
 *
 * Usage: tsx scripts/pretest-guard.ts <service1> <service2> ...
 */
import { execSync } from "child_process";

if (!process.env.CI) {
  execSync(
    `tsx scripts/check-docker-services.ts ${process.argv.slice(2).join(" ")}`,
    {
      stdio: "inherit",
    },
  );
}
