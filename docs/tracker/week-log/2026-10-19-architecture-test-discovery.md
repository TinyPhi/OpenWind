# 2026-10-19 — Discover every API architecture test in CI

**Issue:** #1023

## Problem

The `Cross-package architecture guards` CI step passes
`src/routes/api-keys/decoupling.architecture.test.ts` directly to Vitest. The API currently has two
architecture suites, so CI silently omits `mint-paths.architecture.test.ts` from this dedicated
guard step. The unchanged command ran one file and three tests.

## Decision

Pass `.architecture.test.ts` as Vitest's positional filename filter. Vitest applies positional
filters across the API test root, so this selects every test file using the established
`.architecture.test.ts` suffix regardless of its directory. The candidate command runs both current
files and all five tests.

Do not pass the issue's quoted `**/*.architecture.test.ts` suggestion: Vitest 4.1.10 treats
positional arguments as filename filters rather than shell globs, and that command exits with “No
test files found.”

## Trade-off and residual exposure

The substring filter may also select a nonstandard filename containing `.architecture.test.ts`.
That is conservative for a guard step. A future architecture test using a different naming suffix
will still require an explicit CI decision.

This change introduces no durable state transition: the repository checkout is input supplied to
each CI invocation, and the command only broadens test discovery within that process.

## Verification

- Red: the current CI command runs one file and three tests, omitting the mint-path guard.
- Green: `pnpm --filter @platform/api exec vitest run .architecture.test.ts --reporter=verbose`
  passes two files and five tests.
- `pnpm typecheck` and `pnpm lint` pass for all 52 tasks.
- The full unit run encountered two existing parallel-load timeouts tracked by #873; the affected UI
  package passes independently with seven files and 55 tests.
- The full isolation run on a fresh database completed its assertions but encountered five worker
  hook timeouts under parallel load. All affected suites pass independently on another fresh
  database with five files and 31 tests.
