# Org-view follow-ups (#1072)

Date: 2026-10-22

## Decision

The dashboard will probe `GET /dashboard/org-view/has-reports` on ordinary My View loads and
fetch the full `GET /dashboard/org-view` payload only after the user selects Org View. The probe
is self-scoped from the authenticated tenant and user and uses an indexed org-directory existence
query; it never builds the subtree or reads tickets.

The full org view will request `DASHBOARD_SCOPE_LIMIT + 1` scoped ticket ids, pass at most the
configured limit to the existing builders, and return an additive `truncated` boolean. The UI
will show a non-blocking warning when totals and roster counts were calculated from the bounded
set. Existing response fields and ticket-scope predicates stay unchanged.

Rows without an auth-provider `userId` are invalid non-root employee rows. Subtree lookup excludes
those rows and their descendant branch rather than manufacturing a public identity from the row
UUID. This keeps the direct-report existence probe and the full subtree consistent. The sync
invariant remains that only the synthetic root may have a null `userId`; a malformed branch must be
repaired by the next sync rather than exposed through dashboard authorization.

The manager-visibility predicate raised as item 3 in #1072 is a product decision and is not changed
here.

## Trade-off

The extra probe is a second HTTP request only for managers who open Org View, but it replaces a
full org-table and ticket query on every dashboard load. Reading one extra ticket id avoids an
unbounded count query while making the cap visible; counts remain intentionally approximate when
`truncated` is true.

## Residual exposure

The full org view still reads the complete subtree when opened, and the newest 2,000-ticket bound
still omits older tickets. The warning makes that limitation explicit but does not remove it.

## Stateful behavior

| State                                                       | Event                                     | Outcome                                                                                                                         | Kind       | Evidence                                                                             |
| ----------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Caller has no report row with a `userId`                    | Dashboard loads                           | Probe returns `hasReports:false`; full org view is not fetched; My View is unchanged                                            | changed    | `probes report availability without loading the full org view` and probe route tests |
| Caller has at least one direct report                       | Dashboard loads                           | Probe returns `hasReports:true`; toggle appears; no ticket query runs yet                                                       | changed    | probe route and dashboard toggle tests                                               |
| Toggle visible, full view not loaded                        | User selects Org View                     | Full payload is fetched once and retained across later tab switches, including while its request is in flight                   | changed    | org toggle tests, including the in-flight tab-switch case                            |
| Scoped result has at most 2,000 ids                         | Full org view loads                       | All resolved ids are built; `truncated:false`; no warning                                                                       | introduced | org-view boundary tests                                                              |
| Scoped result has at least 2,001 ids                        | Full org view loads                       | Newest 2,000 ids are built; `truncated:true`; UI warns that totals may be low                                                   | introduced | org-view boundary and UI warning tests                                               |
| Org tree contains a non-root row with `userId = null`       | Subtree is read                           | The invalid row and its descendant branch are absent from returned ids/members and cannot authorize a team view                 | changed    | org-directory subtree unit test                                                      |
| Tenant B reuses a Tenant A user id                          | Either org route is requested in Tenant B | Only Tenant B rows and tickets are returned; Tenant A data remains absent                                                       | unchanged  | dashboard org-view isolation tests                                                   |
| Full org-view request fails after a successful probe        | User selects Org View                     | The successful probe result is retained, so the toggle remains; Org View shows the unavailable state and My View remains usable | changed    | dashboard full-load failure test                                                     |
| Probe returned true, then sync removes the caller's reports | User selects Org View                     | Full response returns `hasReports:false`; UI hides the toggle, resets to My View, and does not leave an active empty Org tab    | introduced | dashboard stale-probe test                                                           |

No durable writes, retry paths, caches, migrations, or external side effects are introduced.

## Verification plan

- Focused org-directory, dashboard API, admin-ui, and real-Postgres isolation tests.
- Repository typecheck, lint, unit/integration tests, and isolation suite.
- Security review of the new authenticated read route and tenant predicates.

## Verification results

- `pnpm typecheck`: pass (52/52 packages).
- `pnpm lint`: pass (52/52 packages).
- Focused org-directory, dashboard API, and admin UI suites: pass (7, 20, and 20 tests).
- Independent design/diff review and security review: pass with no findings.
- `pnpm test`: blocked by an unrelated OpenBao test `beforeAll` timeout while generating its
  local TLS fixture; the issue-specific suites above pass.
- Real-Postgres isolation execution: blocked because the local Docker/Colima daemon is not
  running. The new isolation cases are committed for CI to run against a clean database.
