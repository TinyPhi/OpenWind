## 2026-09-27 — #606 vendor-approval module (3H Phase 1)

**Session type:** Implementation, seed config + tests + dev tooling
**Branch:** `feat/PLAT-606-vendor-approval-module`
**Spec:** `docs/specs/vendor-approval.md` / `docs/specs/vendor-approval-tasks.md`

### Sequencing decision

#607 (action tokens) was considered first and deferred. #607 depends on #606: its tokens act on
#606's transitions and reuse its notify rules. It is also gated on the #607-vs-#608 demand check,
and it is the heavier, auth-adjacent piece. #634 stays a fast-follow. The only part of it folded
in here is a single payload→fields mapping seam, so swapping in a real source later touches only
the caller.

### Done

- `@modules/vendor-approval`, `category: "optional"`: Vendor entity (9 fields); six-state
  sequential workflow; 48h SLA on the three review states; comment-required rejection from each
  review stage.
- **Real department roles:** `it_security` / `legal` / `finance_approver` Zitadel project roles
  gate each review stage, plus `admin`. No engine/auth change was needed, because roles flow
  unfiltered from the JWT into `allowed_roles`. Approvers must also hold `agent`, because of the
  route guards and admin-ui's customer/agent split.
- **Notify rules:** three rules seeded disabled with no recipient. `NotifyConfig` has no role- or
  assignee-based recipient, and that engine change belongs with #607.
- `scripts/bootstrap.ts`: the three roles + three approver users; `createDemoUser` now grants a
  role list.
- `apps/api/src/scripts/vendor-approval-demo.ts`: idempotent setup of six vendors, one at every
  state, with real stored attachments. Input goes through `VendorPayloadSchema` /
  `mapVendorPayload`.

### Found along the way

- **The automation executor never reads `trigger_config`.** Rules match on type + conditions
  only, so a bare `toState` condition fires across every entity type with a same-named state.
  Worked around here by pinning `entityTypeId` in each condition, with a regression test. The
  platform gap (tender is also affected) is filed in `docs/reviews/pending-review-findings.md`.
- **Tender seeds `textarea`, which isn't a registered field type**, so those fields go
  unvalidated. Filed in the same doc.

### Verification

- New tests: 19 passing (12 integration, 3 isolation, 4 unit for the payload mapping), plus the
  core-install suite now asserts vendor-approval never auto-installs.
- Demo script run twice against a throwaway tenant in `platform_test`: six vendors at the
  expected states, second run skipped all six, only the `--notify`-wired rule enabled.
- Review (medium code review + security pass) turned up two fixes, both applied:
  - The demo script now resumes a half-advanced vendor instead of skipping it. Verified by
    knocking `demo-vendor-005` back to `legal_review` without its contract; the rerun finished it
    to `approved`.
  - The script's own reads/updates now run inside `withTenantContext`, so RLS applies alongside
    the explicit tenant filters.
- Exit condition: typecheck/lint 49/49; admin-ui 291/291; worker unit + isolation green; api
  suite green except `third-party-misuse-alerts` (3 tests). That's the known local flake already
  in PROGRESS.md: alert rows accumulate between local runs, and this diff doesn't touch it. Two
  scheduler test failures along the way came from a stale local `platform_test`, and
  `pnpm db:migrate` fixed them.
- **Not yet run:** the admin-ui walk-through across the three approver logins (T12), and a live
  `pnpm bootstrap`. This machine has no Zitadel bootstrap yet.
