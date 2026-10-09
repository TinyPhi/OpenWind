# Multi-Org Sandbox System

> On-demand, isolated trial orgs for prospects — platform admin spins one up, hands it over, resets
> or deletes it later. For sales/demo use.

status: draft
created: 2026-10-05
updated: 2026-10-07

---

## §G Goal

Platform admin creates a fully working, isolated sandbox tenant (org + real seeded users + org
chart + seeded module data) in a few clicks, hands login details to an external prospect for a
real trial or live demo, and later resets or deletes it. No cross-sandbox / cross-tenant leakage.
Works identically local + server.

**Blocking prerequisite — not a task in §T:** the `platform_admin` role is a new, cross-tenant
architectural pattern (first in this codebase). Per CLAUDE.md, a human-authored ADR
(docs/decisions/ADR-022-sandboxing.md) is required before Stage 1 implementation begins. Claude
does not write this ADR.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono API, Drizzle+Postgres (RLS), BullMQ worker, Zitadel (shared project, new org per sandbox), Refine/shadcn admin-ui                                                                                                                                                                                                  |
| auth         | `platform_admin` = Zitadel role claim, same OIDC mechanism as `admin`/`agent`/`user`, but NOT tenant-scoped — dedicated `/platform-admin` login route, required MFA                                                                                                                                                     |
| tenancy      | each sandbox = 1 real `tenants` row + 1 real Zitadel org, same isolation guarantees (RLS + explicit `tenant_id`) as any customer tenant                                                                                                                                                                                 |
| out of scope | self-serve signup; in-app cross-tenant data/log viewer; auto-deletion of expired data; randomized org _shapes_ (names only); conversion-to-paid automation; support impersonation capability; multiple concurrent platform admins or delegated/scoped platform-admin permissions — single trusted operator model for v1 |
| perf         | provisioning (~21+ Zitadel calls) shows live progress, not a single long-held request — built as a trackable/resumable job, polled by the UI                                                                                                                                                                            |
| abuse/quota  | a single `platform_admin` can create at most N concurrently-active (non-deleted) sandboxes; N is a config value, not hardcoded                                                                                                                                                                                          |
| UI scope     | the prospect-facing side has no sandbox-aware UI of its own — they use the normal tenant admin-ui/login exactly like any customer; "sandbox" is an internal-only concept, invisible to the prospect                                                                                                                     |

## §I Interfaces

```
POST   /platform-admin/sandboxes                 -> starts provisioning job, returns job id
GET    /platform-admin/sandboxes/:jobId/progress -> polled by wait-screen {step, total, status}
GET    /platform-admin/sandboxes                 -> list (metadata only: name, created, trial status)
GET    /platform-admin/sandboxes/:tenantId        -> read metadata (no business data)
GET    /platform-admin/sandboxes/:tenantId/handover -> username list + default-password pattern, for handoff
POST   /platform-admin/sandboxes/:tenantId/reset  -> wipes+reseeds module data, cancels queued jobs
DELETE /platform-admin/sandboxes/:tenantId        -> purges OpenWind data + deletes Zitadel org/accts

POST   /platform-admin/mfa/request               -> sends a one-time verification code (R1)
POST   /platform-admin/mfa/verify                -> verifies the code, unlocks the routes above
```

`platform_admin`-reachable response shapes are a **fixed, narrow DTO allow-list** — every response
field returnable to `platform_admin` is enumerated once, centrally, rather than each route
trusting its own author not to over-return. Built: `PlatformAdminSandboxView`
(`packages/db/src/platform-admin-view.ts`: `id`, `name`, `isSandbox`, `createdAt`,
`trialStatus`), produced only by `toPlatformAdminSandboxView()` — every route returns through
this function, never a raw query result.

Sandbox creation payload: `{ orgName, trialDays, modules: string[] }` (modules = which of the 7
core modules get auto-forked+seeded; all 7 remain visible in the catalog regardless).

Key entities:

- `tenants.is_sandbox: boolean`
- `tenants.trial_ends_at: timestamp | null`
- `tenants.created_by_platform_admin: text` (actor id)
- A per-platform-admin active-sandbox counter, backing the quota constraint (R11)
- A per-action record (create/delete/reset only — R9) — **not yet built** (Phase 3, T16); table
  shape still TBD, tracked as an open item in ADR-022 (audit trail for cross-tenant operations)

## §R Requirements

R1: Platform admin is a distinct, non-tenant-scoped role, issued by Zitadel like every other role.
✓ A Zitadel token carrying `platform_admin` is recognized by the backend without requiring a
`zitadel_org_id` → tenant mapping to exist (the normal tenant-resolution step is skipped for it —
`org_id` is never read for a platform_admin token, by design, not merely unvalidated).
✓ `/platform-admin` is a separate login route from `/login`; successful auth routes to a dedicated
dashboard, never the normal tenant-scoped admin-ui shell.
✓ Logging into `/platform-admin` requires MFA before any sandbox-lifecycle route is reachable.
✓ **(revised 2026-10-07)** MFA is implemented as an OpenWind-owned email one-time-code step, not
Zitadel's own second-factor mechanism — Zitadel's hosted instance for this project has no usable
MFA method (no SMTP configured for OTP-by-email, no SMS gateway, and TOTP is not offered as an
option at all on this instance/plan), discovered during implementation. `POST
/platform-admin/mfa/request` emails a 6-digit code (hashed, never stored in plaintext, 10-minute
TTL, 5-attempt lockout) via OpenWind's own outbound-notification path; `POST
/platform-admin/mfa/verify` checks it and marks the admin verified for 12 hours. Built:
`packages/auth/src/platform-admin-mfa.ts`.
✓ A documented local-dev bypass for the MFA requirement exists (`PLATFORM_ADMIN_MFA_DEV_BYPASS`),
and the app refuses to start with that bypass enabled while `NODE_ENV=production` (same guarantee
as the existing `DEV_TENANT_ID`/`SKIP_AV_SCAN` pattern).

R2: Platform admin's powers are limited to sandbox lifecycle only, never business-data access.
✓ Platform admin can create, list, read metadata of, reset, and delete sandboxes.
✓ No route reachable by `platform_admin` returns any sandbox's business data (tickets, org chart
contents, audit entries) — only tenant-level metadata (name, created date, trial status),
enforced structurally by the `PlatformAdminSandboxView` DTO allow-list (§I), not by convention.
✓ At the database layer, `platform_admin_role` (a dedicated, non-superuser, non-BYPASSRLS Postgres
role — ADR-022 Decision 1, Option B) has column-scoped GRANTs on exactly the `tenants` metadata
columns above and zero grants on any business-data table. `app_user`'s membership in this role is
`WITH INHERIT FALSE`, so an ordinary tenant request never passively inherits it.

R3: Creating a sandbox provisions a real, isolated org with a believable team.
✓ A new Zitadel organization is created under the existing shared Zitadel project — no new env
vars/credentials are introduced per sandbox (a dedicated, narrowly-scoped provisioning service
account is used — `ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY`, separate from the existing
read-oriented management credential).
✓ A matching `tenants` row is created with `is_sandbox = true` and the given `trial_ends_at`.
✓ 1 admin + 10–20 real Zitadel accounts are created, following a fixed org template (one shape,
reused every time); names are randomized realistic human names each time, never placeholder
strings.
✓ Username/email collisions (Zitadel uniqueness is instance-wide) are handled by generate-and-retry
until an unused one is accepted — no pre-check/reservation table.
✓ **(revised 2026-10-07, reverses the original forced-password-change criterion)** Every seeded
account is created with `isEmailVerified: true` and no forced password change
(`changeRequired: false` on the Zitadel create-user call). Most of the 10-20 seeded accounts exist
only to populate the org chart and are never logged into; only the 1-2 accounts the platform admin
actually hands off matter, and a prospect wanting a real identity (their own email/name) is a
manual follow-up action, not something provisioning automates. Forcing a password-change screen on
accounts nobody logs into added friction with no benefit.
✓ The org-directory sync (existing feature, unchanged) seeds the chart from this data; the seeded
admin account has no manager and therefore attaches directly under the synthetic root — the top
real position in the chart — using existing org-directory logic with no modification.

R4: The platform admin chooses which modules arrive pre-populated.
✓ All 7 core modules (`crm`, `helpdesk`, `hrms`, `invoicing`, `procurement`, `projects`,
`reimbursements`) are visible in a sandbox's Modules catalog, same as any normal tenant.
✓ At creation time, the admin selects (checkbox/toggle) which of those 7 get auto-forked into a
live, seeded workflow; unselected ones remain visible/forkable by the prospect but start empty.
✓ Selected modules are seeded with a realistic amount of ticket data across workflow states, not
just one or two records.
✓ Selected modules' automation rules (SLA escalation, notification triggers) are also seeded —
acknowledged as requiring real per-module design, not a generic/free extension of ticket seeding.

R5: Provisioning is visible and resumable, not a single fragile long request.
✓ The platform admin sees a wait screen with a live progress indicator (e.g. "creating user
7/20") while a sandbox is created.
✓ Provisioning runs as a trackable job with step-by-step progress persisted as it happens; the
wait-screen polls this job rather than holding one HTTP connection open for the full duration.
✓ A failure partway through records where it got to, rather than leaving no information behind.
✓ On provisioning completion, the platform admin can view/export the seeded username list and the
default-password pattern used, for handing off to the prospect — this is the actual handover
artifact, not just a "done" status (`GET /platform-admin/sandboxes/:tenantId/handover`).

Operational note (review finding, PR #805): the handover artifact (usernames + shared password)
lives in Redis with a 7-day TTL, not a durable DB column — see migration 0137's comment. If a
platform admin misses that window, the endpoint returns 404 ("Handover window has expired"); the
sandbox's Zitadel accounts still exist and are unaffected. Recovery is manual and out-of-band: the
platform admin resets the affected accounts' passwords via the Zitadel console and re-issues
credentials to the prospect directly. There is no in-app re-issue flow — re-running provisioning
would create a second, duplicate org, and extending the Redis TTL after the fact is not supported.

R6: Trial expiry stops everything for that tenant, without deleting data.
✓ `trial_ends_at` is stored per tenant.
✓ Every login attempt, every authenticated API request, and every background job touching a
tenant-scoped resource checks "is now past this tenant's `trial_ends_at`?" directly — no
separate scheduled job flips a precomputed status flag.
✓ Past expiry: login is refused; background jobs for that tenant (sync, schedule-rule ticket
creation, SLA timers, notification dispatch) no-op.
✓ Sandbox data is never auto-deleted on expiry — it persists until an explicit delete action.

R7: Reset returns a sandbox to a clean working state without disturbing its identity.
✓ Resetting a sandbox wipes and re-seeds only module/business data (tickets, workflow instances,
automation-execution history) — org chart, accounts, and credentials are untouched.
✓ Any pending queued background work for that tenant (scheduled notifications, automation
follow-ups) is cancelled as part of reset — nothing fires afterward referencing wiped data.
✓ Concurrent lifecycle actions on the same sandbox cannot interleave: if reset and delete (or two
of the same action) are triggered on the same tenant while one is already in progress, the second
request is rejected (409 or equivalent), enforced by a per-sandbox lock (status column or
advisory lock), not left to the UI to avoid double-submitting.

R8: Deleting a sandbox removes it from both OpenWind and the identity provider.
✓ Delete purges the tenant's OpenWind data via the same mechanism used for GDPR tenant erasure
(`apps/worker/src/tenant-purge.ts`), behind an explicit confirmation step.
✓ Delete also removes the corresponding Zitadel organization and every account under it — no
orphaned Zitadel accounts survive a deleted sandbox.

R9: A simple record exists of completed platform-admin actions; failed attempts are not logged.
✓ Creating, deleting, or resetting a sandbox (successfully) produces a record of who did it, which
sandbox, and when. **Not yet built** — the existing tenant-scoped `admin_audit_log` cannot hold
this (platform-admin actions don't resolve to a single tenant the way every other audit entry
does); ADR-022 tracks the mechanism decision (a dedicated, tenant-id-less audit table is the
leading option) as a prerequisite for Phase 3's T16.
✓ A failed or abandoned creation attempt produces no separate audit record (the admin already saw
it live via R5's progress UI); failures surface through normal error-tracking/ops tooling only.

R10: Internal tooling can distinguish sandboxes from real tenants.
✓ `tenants.is_sandbox` exists and is set `true` for every sandbox, `false`/absent for real tenants.
✓ Internal usage/reporting dashboards can filter on this flag (verifying this doesn't require new
dashboard work in this spec — just that the flag is queryable).

R11: A single platform admin cannot create unbounded sandboxes.
✓ A configurable per-platform-admin cap on concurrently-active (non-deleted) sandboxes exists;
exceeding it returns a clear error, not a silent failure or partial provisioning attempt.
✓ The cap is a config value (`PLATFORM_ADMIN_MAX_ACTIVE_SANDBOXES`), not hardcoded in route logic.

## §V Invariants

- A `platform_admin`-authenticated request never resolves to, or is scoped by, any single tenant's
  `tenant_id` the way every other role's request is — it is cross-tenant by design, and every route
  it can reach must be explicitly reviewed for this (`/security-review` mandatory, no exceptions).
- No route reachable by `platform_admin` ever returns a sandbox's business data — only lifecycle
  metadata. This is the single invariant the entire risk-containment argument for this role rests
  on; enforced structurally via the `PlatformAdminSandboxView` DTO allow-list (§I) and the
  database-layer column-scoped GRANT (R2) — two independent layers, not one.
- Trial-expiry status is always computed live from `trial_ends_at` at the moment of check — never
  cached/stored as a separate boolean that could go stale relative to the timestamp.
- A sandbox's seeded accounts are real, working Zitadel accounts subject to the same uniqueness and
  policy rules as any real customer's accounts — never a parallel/fake identity mechanism.
- `app_user`'s membership in `platform_admin_role` is always `WITH INHERIT FALSE` — an ordinary
  tenant-scoped session must never passively inherit platform_admin's privileges; any future
  widening of `platform_admin_role`'s grants is reviewed against this invariant specifically.
- Exactly one lifecycle action (reset/delete) may be in flight per sandbox tenant at a time.
- A Redis outage or error while checking platform-admin MFA verification always fails closed
  (denies access) — never fails open.

## §T Tasks

**Blocking, not a Claude task:** human-authored ADR (ADR-022) for the `platform_admin` cross-tenant
role. Stage 1 does not start until this ADR is accepted (currently: changes requested, see
ADR-022-sandboxing.md's review history).

### Phase 1 — Foundation — ✅ implemented (PR1, `feat/sandbox-01-platform-admin-foundation`, not yet raised pending ADR acceptance)

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                            | status                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| T1  | `tenants.is_sandbox`/`trial_ends_at`/`created_by_platform_admin` columns + `platform_admin_role`                                                                                                                                                                                                                                                                                                                | done                    |
| T2  | Auth: recognize `platform_admin` claim, skip tenant-resolution                                                                                                                                                                                                                                                                                                                                                  | done                    |
| T3  | `/platform-admin` auth: MFA (OpenWind email-OTP, revised) + production-guarded dev bypass                                                                                                                                                                                                                                                                                                                       | done                    |
| T4  | Dedicated provisioning service-account credential (config + loader)                                                                                                                                                                                                                                                                                                                                             | done                    |
| T5  | Zitadel password-policy spike — open questions written up, not yet verified against a live instance                                                                                                                                                                                                                                                                                                             | open                    |
| T19 | `PlatformAdminSandboxView` DTO + shared response helper — **wired up** (PR12, `feat/sandbox-11-list-endpoint`): the DTO existed but no route read through it until now. New `GET /platform-admin/sandboxes` (list, newest-first) and `GET /platform-admin/sandboxes/:tenantId` (single, 404 for non-sandbox/missing) resolve the backend prerequisite T17's dashboard needed but wasn't itself scoped to build. | done                    |
| T20 | Per-platform-admin active-sandbox cap (config + check helper)                                                                                                                                                                                                                                                                                                                                                   | done                    |
| T22 | Per-sandbox lifecycle-action lock                                                                                                                                                                                                                                                                                                                                                                               | todo (moved to Phase 3) |

### Phase 2 — Provisioning

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | depends |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| T6  | Fixed org template + randomized realistic-name generator + hit-and-retry collision handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T4, T5  |
| T7  | Provisioning job: create org, create accounts (isEmailVerified: true, changeRequired: false per R3), trigger org-directory sync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T6      |
| T8  | Trackable job progress persistence + polling endpoint (R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | T7      |
| T21 | Handover endpoint: seeded username list + default-password pattern (R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T7      |
| T9  | Module-seed data across workflow states, per selectable core module — **done** (PR7, `feat/sandbox-06-module-data-seeding`). "Per selectable core module" resolved as "all 7 core modules, always" for now (no modules-selection field added to `CreateSandboxSchema`; deferred to the Phase 3 dashboard, T17, which has an actual UI for it). Module install was not previously wired into sandbox provisioning at all -- this PR added both `sandbox-module-install.ts` (installs the 7 core modules' schema/workflow/automation-rule seed SQL, since the worker can't import `apps/api`'s `ModuleService`) and `sandbox-module-data-seed.ts` (seeds 4-5 real records per module across its real workflow states, driven by actual `executeTransition` calls, actor `"system"`). Outbox rows the seeding produces are marked delivered immediately so the automation worker never fires real notifications/webhooks against the fabricated data. | T7      |
| T10 | Per-module automation-rule seeding (split per module if effort runs long) — **done** (PR4, `feat/sandbox-04-automation-rule-seeding`) — implemented ahead of/independent of T9: it extends the existing raw-SQL seed pattern (already shipped for helpdesk/tender/vendor-approval) to the remaining 6 core modules, which needed no module-data seeding to land first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | T9      |
| T11 | Retry-vs-rollback decision + implementation for partial provisioning failure — **done** (PR5, `feat/sandbox-05-provisioning-rollback`). Decision: automatic rollback, not retry or manual-only cleanup. On any failure, `processSandboxProvisioningJob` deletes the Zitadel org if one was created (Zitadel's v2 `DeleteOrganization` cascades to delete every account under it, so no per-account cleanup is needed) and then deletes the `tenants` row — but only after a successful org deletion, so a failed org deletion leaves the tenant row + its `zitadel_org_id` in place as a manual-cleanup breadcrumb rather than destroying that trail. The failure audit entry's `rolledBack` field records which case occurred.                                                                                                                                                                                                                    | T8      |

### Phase 3 — Lifecycle & Admin Surface

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | depends                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| T12 | Trial-expiry check: login path + per-request middleware + background-job guard (R6) — **done** (PR8, `feat/sandbox-07-trial-expiry`). `requireAuth` (both the API-key and JWT branches, `packages/auth/src/middleware.ts`) now returns `TENANT_TRIAL_EXPIRED` (403) when `trial_ends_at` has passed — computed fresh against `Date.now()` on every request, never a cached boolean (only the immutable raw timestamp itself may be cached, via a `tenant-status-cache.ts` extension). The new `isTenantTrialActive()` helper is also wired into the 3 background workers that already filter tenants by status for ongoing work (`org-directory-sync-scheduler`, `retention-archival`, `usage-metering`); `tenant-purge.ts` is untouched (only processes already-deleted tenants). Other workers (SLA timers, notification dispatch, schedule-tick, automation-worker) are a documented, deferred follow-up, not silently incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T1                     |
| T22 | Per-sandbox lifecycle-action lock (status column or advisory lock) — **resolved without new code**: `acquireTenantAdvisoryLock` (`packages/db/src/client.ts`) already exists and is the idiomatic pattern this codebase uses for exactly this "at most one in-flight per tenant" shape (see `packages/org-directory/src/sync.ts`'s existing use of it, and that code's own doc comment explaining why an advisory lock was chosen over a row/status-column lock — no stale-lock-on-crash problem). T13/T15 will call `acquireTenantAdvisoryLock(tenantId, "sandbox-lifecycle")` directly when they're built; no schema change or standalone PR needed for T22 itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T1                     |
| T13 | Reset: wipe+reseed module data, cancel queued background work (R7) — **done** (PR10, `feat/sandbox-09-reset`). New `RESET_TENANT_TABLES` list in `apps/worker/src/sandbox-reset-worker.ts` deletes only instance-level business data (entity instances, `workflow_events` history, `automation_executions`, notifications/outbox, labels/tags/alerts/access-requests, attachments/files, saved views, schedule executions, idempotency keys) -- deliberately NOT module CONFIG (`entity_types`/`workflows`/`workflow_states`/`workflow_transitions`/`automation_rules`, reseeded against as-is, never recreated) and NOT org/account identity (teams, on-call, `tenant_users`, `api_keys`, `installed_plugins`, `schedule_rules`, the `tenants` row itself). Reseed re-runs `seedAllModulesData` against `tenants.config.installed_modules` (T9's own bookkeeping) -- no module reinstall. Queued-but-not-yet-processed jobs for the tenant are cancelled across `automationQueue`/`slaQueue`/`dueDateQueue`/`dueDateApproachingQueue` (waiting/delayed only, never active) before reseeding. `POST /platform-admin/sandboxes/:tenantId/reset` acquires the shared `sandbox-lifecycle` advisory lock (T22) before enqueueing and holds it for the job's full duration by awaiting completion (`BullMQ waitUntilFinished`) rather than polling -- deliberately no separate progress endpoint, since the API process holds the lock connection open across the single request/response instead. New migration 0138 + `packages/audit` additions for `sandbox.reset_completed`/`.failed`, mirroring 0136's pattern for provisioning. | T9, T10, T22           |
| T14 | Confirm `tenant-purge.ts` behavior matches "delete this org's data" — **done** (PR9, `feat/sandbox-08-tenant-purge-confirm`). Confirmed: `tenant-purge.ts` already performs a genuine hard-delete across ~36 tables, uniformly regardless of `is_sandbox` (no special-casing — grepped, none exists), with one justified, spec-sanctioned exception (`admin_audit_log` anonymized in place, R9). It's production-wired via `scheduleTenantDeletion`, not dead code. `sandbox_provisioning_jobs` is intentionally excluded from the purge/erasure tables (keyed by `result_tenant_id`, platform-level bookkeeping with no PII, per migration 0137's own comment) — not an oversight. One real gap found and closed: the sandbox handover Redis key was never explicitly cleared on purge, relying solely on its 7-day TTL — `deleteSandboxHandoverCredentials()` is now called as part of the purge flow. Two items explicitly left for T15: (a) no delete-tenant route exists yet that a platform_admin can call for a sandbox; (b) the default 30-day deletion delay (`scheduleTenantDeletion`) is tuned for GDPR real-tenant erasure, not throwaway sandboxes — T15 should decide whether sandbox deletion needs its own immediate/short-delay path.                                                                                                                                                                                                                                                                                                                                                                            | —                      |
| T15 | Delete: also remove the Zitadel org + accounts (R8) — **done** (PR11, `feat/sandbox-10-delete`). New `apps/worker/src/sandbox-delete-worker.ts`: acquires the `sandbox-lifecycle` lock itself (T22, applying the same corrected pattern as T13's review fix from the start), deletes the Zitadel org via `deleteOrg()` if one exists (its own failure does not block OpenWind-side cleanup -- the `tenants` row survives purge as a tombstone with `zitadelOrgId` preserved as a manual-cleanup breadcrumb either way), then flips `tenants.status` to `deleted` with `deletionScheduledAt = now` and enqueues an immediate (`delay: 0`) job on the existing `tenant-purge` queue -- resolving T14's open item (b) by reusing the unmodified, already-trusted purge worker rather than duplicating its logic or inventing a second delay model. `POST /platform-admin/sandboxes/:tenantId/delete` follows the same fast-pre-check-then-worker-owns-the-lock pattern T13 was corrected to use. New migration 0139 + `packages/audit` additions for `sandbox.delete_completed`/`.failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | T14, T22               |
| T16 | Platform-admin audit trail (R9) — mechanism pending ADR-022 sign-off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —                      |
| T17 | Platform-admin dashboard (create, list, status, reset, delete, handover view) — **slice 1 done** (PR13, `feat/sandbox-12-platform-admin-login`): login/MFA/route-guard shell only -- `/platform-admin/login` (reuses the existing Zitadel OIDC sign-in unchanged; `platform_admin` surfaces through the same roles-claim parsing `usePermissions()`/`extractPlatformAdminContext` already use, so no new auth mechanism was needed), `/platform-admin/mfa` (requests + verifies the email code against the existing MFA routes), `/platform-admin/dashboard` (placeholder shell showing identity + logout). `RequirePlatformAdmin` (role) and `RequirePlatformAdminMfa` (calls `GET /platform-admin/session`, the same middleware every other platform-admin route runs behind -- no separate client-side MFA-verified flag to drift from the server's Redis one) gate the whole tree, mounted entirely outside the tenant `<Authenticated>`/`Layout` shell. Also fixed the shared OIDC callback (`pages/callback.tsx`), which previously always routed to the tenant `/dashboard` regardless of role. **Still to build** (a later slice): the actual sandbox list/create/reset/delete/handover UI, on top of T19's now-wired list/detail endpoints.                                                                                                                                                                                                                                                                                                                                                                              | T8, T12, T13, T15, T21 |
| T18 | `/security-review`: cross-tenant write path, RLS/GUC interaction, MFA, DTO allow-list, quota, lock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | T17                    |

phase gate: all unit + integration tests pass before advancing to next phase; isolation tests
required in every phase touching tenant-scoped data or new routes.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                             | root cause                                                                                                                                                                             | promoted to §V?                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| B1  | ADR-022 review (PrabhuVijit) found `GRANT platform_admin_role TO app_user` without `WITH INHERIT FALSE` would let every ordinary tenant session passively inherit the role's privileges | Postgres role membership is additive/inheriting by default; the migration's own comment claimed "zero privileges by construction" but the GRANT statement didn't actually enforce that | Yes — added to §V                                                                                   |
| B2  | TOTP MFA (originally planned, R1) turned out to be unimplementable                                                                                                                      | This Zitadel hosted instance has no SMTP, no SMS gateway, and doesn't offer TOTP as an option at all                                                                                   | No — this is a security-design trade-off, recorded as ADR-022 Decision 10, not just a bug log entry |

---

_spec is source of truth — update as decisions are made._
