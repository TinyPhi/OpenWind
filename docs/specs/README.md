# Specs index

Feature specs written with `/spec`, plus their `-tasks.md` plan companions from `/spec-tasks`.
**Specs stay at their original path once shipped.** Only their `-tasks.md` companions are removed. Code comments and tests cite
`docs/specs/<name>.md`, so moving a spec breaks those references. Mark it `implemented` and
list it here instead.

Status values (`.claude/commands/spec.md`): `draft` → `review` → `approved` → `in-progress` →
`implemented (PR #N)`, or `abandoned` (abandoned specs are deleted unless code cites them). When a spec's PR merges, update its header and this table in
the same PR.

Last reconciled: 2026-09-28 (#694).

## Open

| Spec                                                                | Status | Notes                                                           |
| ------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| [dashboard-severity-tags-origin](dashboard-severity-tags-origin.md) | draft  | Not started — dashboard has no severity/tags/origin widgets yet |

## Implemented

| Spec                                                                                        | Tasks | Shipped via                                                                      |
| ------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| [advisory-lock-direct-connection](advisory-lock-direct-connection.md)                       | —     | #853                                                                             |
| [automation-trigger-config-scoping](automation-trigger-config-scoping.md)                   | —     | see header                                                                       |
| [backup-dr-runbook](backup-dr-runbook.md)                                                   | —     | #482                                                                             |
| [export-audit-trail](export-audit-trail.md)                                                 | —     | #687                                                                             |
| [gdpr-erasure-coverage](gdpr-erasure-coverage.md)                                           | ✓     | #681                                                                             |
| [hosted-ticket-create-handoff](hosted-ticket-create-handoff.md)                             | —     | #542                                                                             |
| [modal-a11y-wave2](modal-a11y-wave2.md)                                                     | —     | #298                                                                             |
| [network-status-awareness](network-status-awareness.md)                                     | —     | #486                                                                             |
| [oncall-routing](oncall-routing.md)                                                         | —     | 3E Phases 1–4 (ADR-016; design: `docs/oncall-routing-design.md`); gaps #570 #571 |
| [outbound-notifications-kill-switch](outbound-notifications-kill-switch.md)                 | ✓     | `isOutboundNotificationsEnabled` (worker)                                        |
| [outbox-automation-idempotent-consumption](outbox-automation-idempotent-consumption.md)     | ✓     | #372 / #380                                                                      |
| [plugin-system](plugin-system.md)                                                           | ✓     | #397 (3B; gaps in #644)                                                          |
| [pool-load-test-tooling](pool-load-test-tooling.md)                                         | ✓     | T1–T3 shipped; T4–T5 (real run + results) deferred                               |
| [reporting-metadata-masking-repair](reporting-metadata-masking-repair.md)                   | —     | migrations 0117–0119 (3G)                                                        |
| [schedule-rules-mandate-fields](schedule-rules-mandate-fields.md)                           | ✓     | #659                                                                             |
| [superset-embedded-dashboarding](superset-embedded-dashboarding.md)                         | —     | 3G Stage 1 (#663–#671)                                                           |
| [superset-standalone-with-zitadel](superset-standalone-with-zitadel.md)                     | —     | 3G Stage 2 (#663–#671)                                                           |
| [team-assign-oncall-fallback](team-assign-oncall-fallback.md)                               | —     | #659                                                                             |
| [temporal-scheduler](temporal-scheduler.md)                                                 | —     | 3F Phases 1–4 (ADR-017; design: `docs/temporal-scheduler-design.md`); gap #580   |
| [tender-management](tender-management.md)                                                   | —     | `modules/tender` (ADR-005)                                                       |
| [third-party-api-list-my-tickets](third-party-api-list-my-tickets.md)                       | —     | see header                                                                       |
| [third-party-api-origin-tagging](third-party-api-origin-tagging.md)                         | —     | #556                                                                             |
| [third-party-api-phase-a-key-management](third-party-api-phase-a-key-management.md)         | —     | #439 / #440 / #449                                                               |
| [third-party-api-phase-b-core-ticket-api](third-party-api-phase-b-core-ticket-api.md)       | —     | #461 / #484                                                                      |
| [third-party-api-phase-d-attachments](third-party-api-phase-d-attachments.md)               | —     | #472 / #475                                                                      |
| [third-party-api-phase-e-status-transitions](third-party-api-phase-e-status-transitions.md) | —     | #484                                                                             |
| [third-party-api-phase-f-access-logs](third-party-api-phase-f-access-logs.md)               | —     | #489 / #546                                                                      |
| [third-party-api-phase-g-hardening](third-party-api-phase-g-hardening.md)                   | —     | #495 / #499 / #500                                                               |
| [third-party-api-workflow-fields-schema](third-party-api-workflow-fields-schema.md)         | —     | #521                                                                             |
| [third-party-key-external-org-mapping](third-party-key-external-org-mapping.md)             | —     | #545                                                                             |
| [third-party-transition-role-mapping](third-party-transition-role-mapping.md)               | —     | #514                                                                             |
| [ticket-severity-and-tags](ticket-severity-and-tags.md)                                     | ✓     | see header                                                                       |
| [user-erasure-anonymization](user-erasure-anonymization.md)                                 | —     | #690                                                                             |
| [vendor-approval](vendor-approval.md)                                                       | ✓     | #680 (live walk-through #691)                                                    |
| [workflow-ownership-admin](workflow-ownership-admin.md)                                     | —     | retroactive spec (ADR-006)                                                       |

The third-party API specs are per-phase delivery detail. The cross-cutting rules and index live
in [`docs/third-party-api-design.md`](../third-party-api-design.md), and the decision is ADR-012.

## Removed after shipping

Once a spec ships, its `-tasks.md` plan companion is deleted unless code cites it or it still
tracks deferred work, because git history and the PR already hold that record. The spec itself
stays. On 2026-09-27 (#694) the tasks files for 14 shipped specs were removed (`backup-dr-runbook`,
`hosted-ticket-create-handoff`, `network-status-awareness`, `team-assign-oncall-fallback`,
`third-party-key-external-org-mapping` and the nine `third-party-api-*` specs), along
with the abandoned `workflow-id-based-linking` spec and its tasks file. Recover any of them with
`c=$(git log --diff-filter=D --format=%h -1 -- docs/specs/<name>.md); git show "$c^:docs/specs/<name>.md"`.

### Specs still cited by code

The 2026-09-18 docs restructure (PR #619, commit `94fbaa2`) deleted shipped specs that code
comments and tests still cite. Recover any of them with `git show 94fbaa2^:docs/specs/<name>.md`:

`2d-no-code-builders-reporting`, `api-request-observability`, `auto-logout-on-inactivity`,
`child-tickets`, `connector-kill-switch` (+tasks), `connector-polling-scheduler` (+tasks),
`due-date`, `group-e-withtenant-context-gaps`, `in-app-notification-hub`,
`local-disk-file-storage` (+tasks), `packages-ui-button-primitive`, `personal-dashboard`,
`security-group-b-api-access-control`, `settings-page-tabs-redesign`, `tenant-org-id-mapping`,
`tenant-scoped-rate-limit-195`, `ticket-alerts`, `ticket-live-updates`, `ticket-reference-linking`,
`workflow-open-ticket-creation` (+tasks).

The ADR drafts `adr-016-draft-oncall-routing` and `adr-017-draft-temporal-scheduler` were removed
in commit `88cd43c` (#591) once the ADRs were accepted. Recover them with
`git show 88cd43c^:docs/specs/<name>.md`.

These paths are cited but were never committed: `dashboard-severity-tags-origin-tasks`,
`docs-config-hygiene-193-203-204`, `port-nexus-ow-fixes`, `third-party-api-phase-c-interaction-api`,
`user-auth`.
