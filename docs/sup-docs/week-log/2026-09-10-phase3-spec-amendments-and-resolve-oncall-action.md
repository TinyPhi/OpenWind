# 2026-09-10 — Phase 3 spec amendments (#596) + resolve_oncall automation action (PR 7, #597)

Session resumed the 3E/3F stacked-PR rollout after confirming Phase 1/2 (PRs 1-6, `#583`/`#585`/
`#586`/`#590`/`#594`/`#595`) were all raised with CI green. Two queued spec follow-ups blocked
Phase 3's plan-locks; both were resolved and landed, then PR 7 was implemented.

## Spec amendments (#596)

`open-questions.md`'s "Follow-up needed before Phase 3" section tracked two real spec gaps
discovered after the specs were already fixed. Human sign-off obtained on the open decisions,
then landed as a small docs-only PR:

- **Temporal-scheduler stale-owner/repeated-failure auto-pause** (`docs/specs/temporal-scheduler.md`,
  new `R-stale-owner` requirement, `T3b`/`T10b` tasks): 3-consecutive-failure threshold (confirmed,
  matches the ADR-017 draft), one free retry on resume before re-pausing (failure counter resets
  to 0 on resume, not left at the threshold), new `schedule.rule_auto_paused` audit action distinct
  from admin-initiated `schedule.rule_paused`.
- **On-call cascading availability fallback** (`docs/specs/oncall-routing.md`, new `R8b`
  requirement): primary → backup → escalation, reusing the same "is this user active" check
  planned for the stale-owner mechanism; confirmed R9's fail-open coverage-gap behavior applies
  identically whether reached via "no schedule" or "all three tiers unavailable" — no separate
  audit action or UI treatment for the exhausted-cascade case.

## PR 7 — `resolve_oncall` automation action (#597)

Implemented the on-call auto-assign feature per R8/R8b/R9/R10/R11. Two real gaps surfaced mid-
implementation, both handled deliberately rather than worked around silently:

1. **`entity.updated` didn't exist as an automation trigger at all.** No event schema, and the
   outbox-poller's allowlist deliberately excluded it (a past-incident comment there warns against
   claiming non-trigger event types). Added fresh: `EntityUpdatedV1Schema` with a `changed`
   field-diff map (old/new per changed field), since `evaluateConditionTree` only supports flat
   current-value lookups, not old/new diffing — so "did team_id change" is checked inside the
   `resolve_oncall` action itself, not a ConditionTree operator. `packages/entity-engine/src/
engine.ts`'s existing `changed` map (already computed for the `workflowEvents` "Record updated"
   row, already redacted for pii/financial fields) is reused as-is for the new outbox payload — no
   separate/weaker redaction path.
2. **Two genuine dependency-graph questions**, both surfaced to the user rather than assumed:
   `automation-engine` needed to reuse the same on-call cascade/schedule-lookup helper as the
   `/current` route (in `packages/teams`, not previously an allowed dependency), and needed to
   write `oncall.*` audit entries directly (`packages/audit`, also not previously allowed —
   `entity-engine` instead uses a hook-registration pattern to keep audit out of its own deps, but
   building an equivalent hook mechanism for a 3-call-site feature was judged more scope than
   warranted). Both confirmed and landed as CLAUDE.md dependency-table extensions with rationale —
   `teams` and `audit` each depend only on `db`, so neither introduces a cycle.

Also flagged, not fixed here (tracked separately since PR5/#585): `team_id`/`service_id` aren't
yet seeded system fields on the real `ticket` entity type — blocked on a related but distinct
entity-engine → teams dependency question. `resolve_oncall` works correctly once that lands;
tests exercise it against a plain custom field in the meantime.

Shared helper extracted into `packages/teams/src/oncall-resolver.ts` (`getActiveScheduleForTeam`,
`getUsersResolvableSet`, `isUserResolvable`, `classifyOncallUser`, `resolveOncallCascade`),
reused by both the new action and a refactor of the `/current` route (no behavior change there —
confirmed via the existing route's unit tests).

Security review (`security-reviewer` agent): no blockers. Two low/informational items fixed —
tightened `ResolveOncallConfig.instanceId` to `.uuid()` (was a bare unconstrained string, the only
`instanceId`-shaped field in the codebase without that constraint), and added a one-line comment
explaining why the Redis idempotency key isn't tenant-prefixed (an `entity_instances.id` UUID is
globally unique, so cross-tenant collision is cryptographically negligible, not tightened further).

## CI fixups (both caught by real CI, not local)

1. **Prettier formatting** — a task-table row edit in `oncall-routing.md` had an escaped-underscore
   spacing issue; mechanical fix.
2. **Isolation test fixture bug** — the new `resolve-oncall.isolation.test.ts` failed in CI
   (`assignedTo` came back `null` instead of the primary user) because the fixture never inserted
   `tenant_users` rows for the test users. `isUserResolvable` correctly treated both as
   unresolvable per R8b's design, so the cascade exhausted to the fail-open path — the assertion
   was right, the fixture was incomplete. This is exactly the class of bug the isolation suite
   exists to catch; the standing Windows-local-Postgres-credential limitation just meant it wasn't
   caught locally before push. Fixed by inserting `tenant_users` rows in `beforeAll`.

All CI checks now pass on #597: Quality gates, Security scan, Tenant isolation (confirms the
cross-tenant test itself ran and passed against real Postgres), Tests, CodeQL, CI complete.

## Verification

- `pnpm typecheck` / `pnpm lint` / `pnpm dep:check`: clean across `teams`, `automation-engine`,
  `telemetry`, `entity-engine`, `api`.
- Unit tests: `teams` 15, `automation-engine` 104, `telemetry` 22, `entity-engine` 241, `api` 705
  (non-isolation) — all passing locally.
- Isolation test: failed once locally (standing Windows-Postgres-credential limitation, unrelated
  to the code), then failed once for real in CI (the fixture bug above), now passing in CI.

## Next

Phase 3's spec-shaping blockers are fully cleared. PR 8 (`tagsev-3e-dispatch-severity-notification`)
and PR 9 (`tagsev-3f-scheduler-worker-tick`) can both be planned without further spec amendments.
Priority order per `pr-tracker.md`: watch #585/#586/#590/#594/#595/#596/#597 for review activity
first (no open PR currently has red CI or an unaddressed review comment), then start PR 8.
