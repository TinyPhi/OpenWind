# 2026-10-19 — Worker tests and chores (#827, #837, #866)

**Session type:** Implementation and review follow-ups
**Branch:** `test/worker-tests-and-chores`
**Issues:** #827, #837, #866

- **Done.**
  - `module-seed-automation-rules.test.ts` (#827): extended the seed rules coverage guard to validate
    `trigger_type`, `trigger_config`, and `conditions` across all 15 module-seeded rules in addition to
    `actions`. Built a zero-eval deterministic recursive descent tokenizer for PostgreSQL `jsonb_build_object`
    and `jsonb_build_array` expressions used by the vendor-approval seed. Tightened per review feedback:
    throws on malformed syntax, missing commas, or unparseable input instead of returning null; asserts that
    parsed rule count equals the number of `INSERT INTO automation_rules` statements.
  - `sandbox-reset-worker.ts` (#837): folded the architectural rationale for omitting `notificationQueue` and
    `outboxQueue` directly into `cancelQueuedJobsForTenant`'s docblock, documenting that jobs in those queues
    reference `notification_recipients`/`outbox_events` rows that are wiped in the same reset transaction,
    failing gracefully without data-corruption risk, while the four scanned queues directly reference
    `entity_instances`.
  - `worker-entry-wiring.test.ts` (#866): pinned the three core sandbox workers (`sandbox-provisioning-worker.ts`,
    `sandbox-reset-worker.ts`, `sandbox-delete-worker.ts`) as a floor while dynamically validating all
    discovered BullMQ worker modules in `apps/worker/src`.
- **Verified.**
  - `pnpm --filter @platform/api test --pool=threads module-seed-automation-rules.test.ts`: 12/12 pass.
  - `pnpm --filter @platform/worker test --pool=threads worker-entry-wiring.test.ts`: 2/2 pass.
  - Typecheck and ESLint pass across `@platform/api` and `@platform/worker` with 0 warnings.
