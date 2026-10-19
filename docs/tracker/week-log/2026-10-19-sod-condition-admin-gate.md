# 2026-10-19 — #1008: only a person admin can change an actor rule

- New `apps/api/src/lib/sod-rule-gate.ts`: `assertMaySetActorRules` refuses (403) a caller who is not a
  person holding `admin` (an `apikey:` caller never counts) when a transition write adds, changes or removes an
  `actor_*` condition. Same shape as the `allowStateOverride` gate in `workflows/update.ts`.
- Applied to transition create, update and delete, to the canvas save when it deletes or re-points a ruled
  transition, and to workflow delete. The last two came from the security review.
- Chose the admin gate over a stored locked flag: no migration, and the issue named it first. A stored flag
  would be a schema change plus an ADR; revisit if the lock should outlive the rule.
- Spec known-limit rewritten (docs/specs/segregation-of-duties.md §K).
- Not covered: a concurrent edit (no row lock on the pre-read), module/plugin install and seed paths; admin-ui does not hide the controls, so a refused
  save shows the API error.
