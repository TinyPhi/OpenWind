## 2026-08-28 — Post-Phase-G E2E testing: 2 bugs found and fixed (PR #513, #514)

**Session type:** Bug fix + review response
**Branches:** `fix/idempotency-canonicalize-esm-cjs` (PR #513, merged), `fix/third-party-transition-role-mapping` (PR #514, open)

### Context

Ran the full ADR-012 Phase A–G third-party API end-to-end against a live server using a new
reference client, **OWTester** (later rebuilt as a standalone browser console, **OWTesterUI** —
see `openWindTest/HOW-THIS-TESTER-WORKS.md`), with a real Zitadel-issued acting-person token.
This surfaced two real bugs that unit/isolation tests hadn't caught.

### Bug 1 — third-party transition role-mapping gap (PR #514)

`executeThirdPartyTransitionHandler` always called `executeTransition` with `actorRoles: []`.
Every real seeded workflow (Expense Approval, Order Fulfillment, Tender1, NSI Amendment, Sales &
Tender Opportunity, Payment Follow-up) restricts `allowed_roles` on its transitions — only one
trivial demo workflow doesn't. Result: the third-party transition endpoint was unreachable for
any real workflow, even for callers who already had legitimate ticket-level access
(creator/assignee/workflow-admin, per `hasTransitionAccess`).

Fix (spec: `docs/specs/third-party-transition-role-mapping.md`): grant the baseline `"user"`
role, but only after `hasTransitionAccess` has already confirmed access — additive to that gate,
never a substitute. Never grants `"admin"`/`"agent"`.

**Review round (PrabhuVijit, principal-engineer pass):** `CHANGES_REQUESTED` —

- F-01 (blocker): isolation tests only covered the creator path, not assignee/workflow-admin
- F-02 (blocker): spec shipped with `status: draft` and every task `todo` despite a live, tested fix
- F-03/S-01 (non-blocking): no mechanical guard against future accidental role elevation
- F-04 (non-blocking): two fixtures shared the same `(open, processing)` state pair
- F-05 (non-blocking): ADR-006's `__accessUsers` gap interaction wasn't documented

All five addressed same session: added assignee + workflow-admin isolation tests (19/19 passing),
updated spec metadata to `implemented`, introduced `THIRD_PARTY_BASELINE_ACTOR_ROLES = ["user"] as
const`, renamed fixtures to distinct `toState`s, added a §C note on the ADR-006 gap's changed
reach. Posted as a PR comment requesting re-review.

### Bug 2 — idempotency `canonicalize` ESM/CJS crash + TOCTOU regression (PR #513)

`canonicalize` is pure-ESM; `apps/api` has no `"type": "module"`, so a static `import` transpiles
to `require()` at runtime and crash-loops the server (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — only
caught by booting the real compiled server, since vitest tolerates ESM-only deps transparently.
Fixed via a dynamic `import()`, making `computeContentHash` async. Separately, PR #502 had
silently reverted PR #500's double-checked-locking fix for the idempotency cache/lock TOCTOU
race; restored it.

**Merge conflict, twice:** PR #510 landed on `main` independently fixing the same TOCTOU pattern
while this branch was open — first reconciliation merged `main` in and resolved the conflict in
favor of `main`'s simpler `lookupCached()` structure. A second, near-simultaneous push by
PrabhuVijit's own agent reconciled the identical conflict independently; merged both, keeping the
terser inline form.

**CI failure after merge:** the merged-in TOCTOU test (from PR #510) called
`computeContentHash(content)` without `await` — predating this branch's async signature change.
The un-awaited call produced a `Promise` object instead of a hash string, so it never matched the
real hash and the test always fell into the 409-conflict branch instead of the expected 201
replay. Fixed with one `await`. All 12 tests passing, typecheck clean.

PrabhuVijit validated the fix directly (audited all 8 `computeContentHash` call sites, confirmed
the two double-checked-locking tests — PR #513's and PR #510's — are complementary, not
redundant): **"Ready to merge. CI is green, conflicts resolved, approval stands."** Merged to
`main` 2026-08-28.

### Branch sync

`tushar` synced to `upstream/main` (post-#513-merge) and to PR #514's branch — one further
conflict in `idempotency.ts` (same `lookupCache`/`lookupCached` pattern mismatch, same
resolution), clean merge otherwise. Verified with `pnpm typecheck` + the idempotency and
transition isolation suites; pushed.

### Verification

- pnpm typecheck: PASS (all branches touched)
- pnpm lint: PASS (via lint-staged on each commit)
- Idempotency unit suite: 12/12 PASS
- Third-party transition isolation suite: 19/19 PASS
- pnpm test:isolation (full suite): not run locally — pre-existing local PgBouncer/postgres.js
  environment quirk (unrelated to these changes, confirmed earlier this session); CI's own
  Postgres/PgBouncer service validated independently, green

### Next

- PR #514 awaiting PrabhuVijit's re-review
- Continue closing out ADR-012 Phase G follow-up issues (#490–#498) as they come up
