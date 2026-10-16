# 2026-10-16 — Migration journal strict ordering (#895)

**Session type:** Bug fix
**Branch:** `fix/PLAT-hardening-journal-strict-order`
**Issue:** #895 (premise corrected in the issue: not cosmetic)

- **Done.** 0141's journal `when` is now 1789033329001 (strictly between 0140's 1789033329000 and 0142's
  1789119729000). `packages/db/src/migration-journal.test.ts` checks that idx runs 0..n-1, tags are unique and have
  a `.sql` file, and every `when` is strictly greater than its predecessor, with the three older shipped
  exceptions listed explicitly; the last test fails if an exception is fixed and left on the list.
- **Why it matters.** drizzle-orm 0.45.2 (`pg-core/dialect.js` `migrate()`) reads the latest applied `created_at`
  once and runs a migration only if that is strictly less than the migration's `when`. It does not use `idx`.
- **Verified end to end.** The real migrator against a throwaway database migrated to 0140 and then to the full
  journal: with the original journal 0141 is skipped and 0142 fails (`relation "platform_admin_audit_log" does not
exist`, rolled back at 141 applied); with the fixed journal all 149 apply and the table exists.
- **Deferred.** The three older pairs have the same hazard for a database that stopped at the earlier one:
  0019 to 0020, 0039 to 0040 (equal) and 0049 to 0050. Each is a one-value fix that stays strictly below the next
  entry (0020 to 1781683200001, 0040 to 1783417689001, 0050 to 1785542402000). They touch already-shipped
  entries, so they are left for an owner decision; remove the matching test exception with each.
