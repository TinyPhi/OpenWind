## 2026-10-31 — client onboarding guide (PLAT-1135)

### Done

- Added `docs/client-onboarding.md`: a checklist guide for what OpenWind must have in place when
  onboarding a client (roles, pre-contract checks, contracts and DPA clauses, representatives,
  registers, legal basis, technical checklist, go-live gates, exit, open questions).
- Linked it from `docs/runbooks/README.md` (operational docs that are not runbooks).
- Engineering and compliance working draft, not legal advice. Unknowns are `TBD` placeholders and
  every item that could not be verified in the repo is marked UNVERIFIED.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Open questions

- See section 11 of the guide (owner and counsel lists). Notable repo gaps found while writing it:
  no documented way to map a real customer tenant to its Zitadel org, tenant purge does not remove
  the Zitadel org, module uninstall hides but does not delete data.
