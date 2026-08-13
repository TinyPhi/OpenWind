# Definition of Done — OpenWind

The verified-completion contract. The Review stage checks the diff against this list and records
the result in `.claude/state/review.json` (`dod_met` / `dod_unmet`); the commit gate refuses if
`dod_met` is false. "Compiles" and "seems right" are **not** done — evidence is.

A change is **done** only when every applicable box is true:

## Correctness (proof, not assertion)

- [ ] Behaves as intended, **verified at runtime** — not just typechecked or compiled.
- [ ] New behavior is covered by a test that **fails without the change and passes with it**.
- [ ] Existing tests still pass; no regressions. `pnpm test` green.
- [ ] Bug fixes include a reproduction test that failed before the fix.
- [ ] No skipped/`.only`/disabled tests left behind.

## Scope (no creep)

- [ ] Changes are **scoped to the plan-lock's `acceptance_criteria` + `scope_paths`** — no unrelated
      refactors snuck in. Each criterion's `verify` command actually ran green before `done:true`.
- [ ] No dead code, debug logging, or commented-out blocks added.

## Platform invariants (OpenWind-specific)

- [ ] **RLS**: every new tenant-scoped table has `tenant_id NOT NULL`, RLS enabled, both policies, an index.
- [ ] **Isolation tests** added/updated under `tests/isolation/` for any new table or route (mandatory).
- [ ] **Config-first**: no TypeScript added under `modules/` — modules are seed SQL only (ADR-004).
- [ ] No `any`; types derive from Zod. No direct `process.env` (use `@platform/config`). No raw SQL string-building.
- [ ] Analytics annotation on every new `CREATE TABLE`.

## Quality gate (the exit condition)

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation` all green.
      (`test:isolation`/`test:e2e` need the Docker/OrbStack stack — if it is down, surface a blocker, do not silently skip.)

## Integration & docs

- [ ] Works with the whole system; migrations/config/flags accounted for; backward-compat considered.
- [ ] A new dated file added under `docs/sup-docs/week-log/` (never edit `week-log.md` itself —
      frozen history) and `docs/sup-docs/roadmap-tracker.md`'s **own track row** updated (leave
      the Summary scorecard for reconciliation — see that doc's header).
- [ ] `CHANGELOG.md` entry for user-facing changes.
- [ ] If an architectural decision was made: an ADR is **flagged as needed** (ADRs are human-written — do not author one).
- [ ] **Enforced separately at commit time**, not just here: `write-docs-marker.sh --touched` (docs are in the diff) or `--skip "<reason>"` (this diff genuinely has no doc surface) — the commit gate refuses without a marker matching the diff. See the Docs stage in `.claude/README.md`.

## Security (when the diff touches auth / db / routes / files / secrets)

- [ ] `/security-review` run; findings triaged. RLS, Zod validation at boundaries, presigned-URL-only file access, rate limiting in place.

## Ship-readiness

- [ ] Rollback path exists for anything risky.
- [ ] **The human approved the pass** (`approve-ship` in chat) before commit — required until the owner sets `OPENWIND_AUTOPASS=1`.

---

### Anti-rationalization

| The excuse                               | The reality                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| "It typechecks, so it works."            | DoD requires runtime-verified behavior. Typecheck is necessary, not sufficient.   |
| "The test passes immediately."           | A test that passes without the change proves nothing. It must fail first.         |
| "I'll add tests after."                  | The review gate needs tests in the diff. "After" = never.                         |
| "Small change, skip the isolation test." | New table/route without an isolation test is exactly how tenant leakage ships.    |
| "I'll just tidy this nearby code too."   | Out of `scope_paths` = out of scope. File it; do not smuggle it into this commit. |
