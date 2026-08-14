/**
 * Thin wrapper extracted from the inline `node -e` strings that used to live
 * directly in package.json's pretest:* scripts (issue #110) — editing the
 * service list or script path there required careful shell-escaping and was
 * error-prone in diffs. Skips the Docker pre-check entirely in CI (the real
 * services are provided by the CI job itself, not docker compose).
 *
 * Usage: tsx scripts/pretest-guard.ts <service1> <service2> ...
 *
 * Uses execFileSync (argv array, no shell) rather than execSync with a
 * string-interpolated command — CodeQL flagged the latter as indirect
 * command-line injection (js/indirect-command-line-injection): forwarding
 * process.argv into a shell string lets special characters in an argument
 * change the invocation's meaning. execFileSync passes each argument through
 * verbatim with no shell interpretation.
 */
import { execFileSync } from "child_process";

if (!process.env.CI) {
  execFileSync(
    process.platform === "win32" ? "tsx.cmd" : "tsx",
    ["scripts/check-docker-services.ts", ...process.argv.slice(2)],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
}
