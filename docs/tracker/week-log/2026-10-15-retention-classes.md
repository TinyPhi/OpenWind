# 2026-10-15 — retention classes and tenant-context sweeps

**Session type:** Security hardening, PR 4 of the hardening program
**Spec:** `docs/specs/retention-classes.md`
**Branch:** `feat/PLAT-hardening-retention-classes`

- **Found.** The retention sweep ran on plain `db` (no tenant context), so as `app_user` it deleted
  nothing. The usage-metering sweep had the same pattern.
- **Done.** Per-tenant work now runs under `withTenantContext`. `workflow_events` are swept by
  structural class (evidence / comment / noise); evidence of open or recently active cases is never
  swept. Per-tenant windows and hold, validated env defaults, batched deletes, a deleted-rows metric.
- **Verified.** Real-Postgres isolation test as `app_user`; mutation checks confirmed the open-case
  guard and the hold are what the tests exercise.
- **Open for the owner.** Confirm the comment (365) and evidence (2555) default windows with counsel.
