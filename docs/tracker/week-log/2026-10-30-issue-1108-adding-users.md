## 2026-10-30 — Document adding users through Zitadel (#1108)

**Session type:** Documentation
**PR:** Pending
**Branch:** `fix/PLAT-1108-zitadel-user-docs`

## Decision

The setup guide will contain a top-level **Adding users** procedure. It will state that OpenWind
does not create users itself: an organisation administrator creates each user in the matching
Zitadel organisation, supplies their first name, last name, and email address, chooses whether
Zitadel should verify the email, configures a sign-in method, and grants OpenWind project access
when the deployment requires it.

The procedure will not add environment-specific console URLs, credentials, project names, or role
names. Operators will use the values and access policy of their own deployment.

## Trade-off

Keeping the procedure in the setup guide gives operators one durable place for both local and
deployed environments, but it remains a manual identity-provider workflow rather than an OpenWind
admin action.

## Residual exposure

Zitadel deployments can enforce different invitation, password, verification, and project-grant
policies. The guide explains the required outcome without pretending that one sign-in setup fits
every deployment. Creating Zitadel users from the OpenWind admin UI remains out of scope.

## Stateful behavior

This documentation-only change does not read, write, or branch on state that outlives a process.

## Verification plan

- Check that the setup guide contains the complete user-creation and first-sign-in procedure.
- Check formatting with the repository's Prettier version.
- Run the repository typecheck, lint, unit/integration, and isolation gates on the final branch.

## Verification results

- Focused content and docs-only scope checks: passed.
- `pnpm exec prettier --check` for both changed files: passed.
- `pnpm typecheck`: passed (52/52 tasks).
- `pnpm lint`: passed (52/52 tasks).
- `pnpm test`: 39/42 tasks passed; the worker task reported two 10-second isolation-hook
  timeouts under the combined parallel run (598 worker tests passed, 5 skipped).
- `pnpm test:isolation` on a separate freshly migrated database: passed (21/21 tasks), including
  all 145 API isolation files and the worker isolation files that timed out in the combined run.
