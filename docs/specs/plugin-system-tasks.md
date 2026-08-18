# Implementation Plan: Plugin System (3B)

**Spec:** docs/specs/plugin-system.md
**Generated:** 2026-08-13
**Status:** all three phases shipped 2026-08-13 (PR #397, in review)

---

## Phase 1 — Data & Lifecycle Core

**Goal:** the plugin_definitions/installed_plugins/plugin_errors schema exists with real
enforcement (grants, RLS, tenant isolation) and the lifecycle service can install/validate a
plugin end to end, with nothing yet reachable from an HTTP route.
**Gate:** unit + isolation tests pass → then Phase 2.

| task                                                                                                                                                                                                                                                                                           | requirement     | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------ |
| T1: `plugin_definitions` + `installed_plugins` + `plugin_errors` migration — trust*tier CHECK, standard RLS pair on the two tenant-scoped tables, composite unique index, plugin-migration-role grant scoped to `plugin*<slug>` only                                                           | R1, R2, R4, R8  | done   |
| T2: Plugin lifecycle service core — resolve deps (hard-block policy) → validate (incl. R13's static tenant_id+RLS check on plugin migration SQL) → run migration → register → activate, transactional status writes                                                                            | R3, R13         | done   |
| T3: Governor limits — wrapped DB client (query timeout + row ceiling) as the _only_ DB import available to plugin code; job-execution timeout wrapper                                                                                                                                          | R5, R4-addendum | done   |
| T4: `@platform/plugin-sdk` version/compat-check policy — `platformVersion` validated at install, semver deprecation policy documented                                                                                                                                                          | R10             | done   |
| T5: Isolation tests — cross-tenant `installed_plugins`/`plugin_errors` access blocked; schema-grant enforcement (a migration attempting `CREATE TABLE public.x` fails); `tenant-purge.ts` extended to delete `WHERE tenant_id = ?` inside every installed plugin's schema, verified end to end | R2, R4, R13     | done   |

---

## Phase 2 — Service Layer

**Goal:** a plugin can be installed/uninstalled/listed through the real admin API.
**Gate:** integration tests pass + Phase 1 gate still green.

| task                                                                                                           | requirement | status |
| -------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T6: Admin routes — `POST .../install`, `DELETE .../:pluginSlug`, `GET .../plugins`, all `requireRole("admin")` | R3, R9      | done   |
| T7: Uninstall — drop `plugin_<slug>` tables for that tenant by default, `retainData=true` opt-out              | R9          | done   |
| T8: Dependency hard-block wired to the real API response shape (named-dependency 4xx)                          | R3          | done   |

---

## Phase 3 — Consumer-Facing Layer

**Goal:** a first-party plugin's UI actually renders inside admin-ui, isolated per slot, with
integrity-checked remote loading and a health view.
**Gate:** §R's `✓` acceptance criteria met across the whole spec.

| task                                                                                     | requirement | status |
| ---------------------------------------------------------------------------------------- | ----------- | ------ |
| T9: Module Federation host + `<Slot>` component with per-slot error boundaries           | R6, R7      | done   |
| T10: SRI hash validation for `remoteEntry.js`                                            | R12         | done   |
| T11: Plugin health dashboard (admin-ui, `<EntityList>` family, filtered `plugin_errors`) | R11         | done   |

---

## Kick-Off Prompt

Copy this into the session that implements Phase 1:

```
Read docs/specs/plugin-system.md and docs/specs/plugin-system-tasks.md.

Implement Phase 1 tasks only (T1-T5).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass (unit + isolation)
- T5's isolation tests are not a follow-up - they land in the same PR as T1-T4
- If a decision isn't covered by the spec, stop and ask - do not assume
- If a test fails, log it in docs/specs/plugin-system.md's §B before fixing
- If the same bug class could recur, promote it to §V
```

---

## Backprop Reminder

If any Phase 1 test fails during implementation, log it in `docs/specs/plugin-system.md`'s §B
before fixing. If a pattern emerges that shouldn't repeat, promote it to §V.
