# 2026-10-19 — State override UI, direct-write lock, vendor-approval segregation of duties (#775, #776)

**Session type:** Implementation
**Branch:** `feat/PLAT-state-override-ui-sod-seed`
**Issues:** #775 (T5), #776 (T7)

- **Done.**
  - Admin-ui: a workflow settings switch for `allowStateOverride` (tenant admins) and an "Override state…"
    dialog on the record page (admin, switch on, not the record's creator) that posts to the existing
    `override-state` route with a reason of 10 to 1000 characters.
  - Direct state writes are refused (`409 STATE_CHANGE_NOT_ALLOWED`) on any workflow that has the override
    switched on or an actor-rule transition: `PATCH /entities/:id`, `POST /entities/:id/state`,
    `POST /entities/bulk/state` (per item), and `POST /entities` with a non-initial `currentState`. This
    closes the bypass the segregation-of-duties spec said blocked enabling the rules.
  - `vendor-approval` seed (T7): review and approval transitions drop `admin`, carry
    `actor_not_creator` + `actor_not_prior_actor`, and the workflow ships with the override on. The demo script
    now acts as one identity per role.
- **Decision to confirm.** The lock applies only to workflows that use the override or an actor rule, not to
  every workflow. Locking all workflows would break the generic entity-type instance page, which still calls
  `POST /entities/:id/state`. Removing the legacy path everywhere is a separate decision.
- **Security review.** One finding fixed: attaching a record under a parent made it a child ticket and took the
  child-state path past the lock, so a child write on a locked workflow is now refused when the target is also a
  step of its workflow (tested, mutation-checked). One recorded, not fixed: a workflow admin who is not a tenant
  admin can clear a transition's actor rule, which also lifts the lock on a workflow without the override switch.
- **Known limits.** Re-installing the module on a tenant with the workflow replaces the transitions but keeps
  the tenant's switch setting. Existing installs (none released) keep their old transitions until re-seeded.
- **Tests.** Real-Postgres isolation test for the lock (mutation-checked: disabling the lock fails 5 of 8),
  vendor-approval integration tests for the requester, repeated-approver, admin-without-role, override and
  direct-write cases, admin-ui tests for the dialog, error mapping test.
