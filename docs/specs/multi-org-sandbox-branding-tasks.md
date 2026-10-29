# Implementation Plan: Sandbox branding (R12)

**Spec:** docs/specs/multi-org-sandbox.md (§R12, §T Phase 4, T24–T32)
**Generated:** 2026-10-23
**Status:** implemented on `feat/sandbox-branding` (PR pending)

---

## Phase 1 — Data and db helper

**Goal:** `tenants.logo`, an audited sandbox-only write path, and `logo` on the platform-admin view.
**Gate:** db unit tests pass, migration applies on a throwaway Postgres

| task                                                                     | requirement | status |
| ------------------------------------------------------------------------ | ----------- | ------ |
| T24: migration (column, CHECK, SECURITY DEFINER fn, grants, audit CHECK) | R12         | done   |
| T25: `setSandboxBranding`, audit action, `logo` on the view              | R12, R9     | done   |

## Phase 2 — API

**Goal:** platform admin can edit; sandbox users can read.
**Gate:** route tests pass + Phase 1 gate still green

| task                                                      | requirement | status |
| --------------------------------------------------------- | ----------- | ------ |
| T26: `PATCH /platform-admin/sandboxes/:tenantId/branding` | R12         | done   |
| T27: tenant `GET /me/org`                                 | R12         | done   |
| T28: purge clears logo on the tombstone row               | R12, R8     | done   |

## Phase 3 — UI, isolation, review

**Goal:** the header and the dashboard dialog work end to end.
**Gate:** §R12 acceptance criteria met; full exit condition green

| task                                           | requirement | status |
| ---------------------------------------------- | ----------- | ------ |
| T29: dashboard "Edit branding" action + dialog | R12         | done   |
| T30: header brand block                        | R12         | done   |
| T31: isolation tests                           | R12, R2, R7 | done   |
| T32: `/security-review`, docs                  | R12         | done   |

---

## Kick-Off Prompt

Read docs/specs/multi-org-sandbox.md (§R12, Phase 4) and this file. Implement Phase 1 (T24, T25)
first. Do not start Phase 2 until Phase 1 tests pass. Stop and ask on any decision the spec does not
cover. Log failures with `/spec amend §B`.
