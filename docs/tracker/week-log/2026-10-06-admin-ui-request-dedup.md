# 2026-10-06 — admin-ui request deduplication and session-scoped caches (2 of 5, split from #772)

**Session type:** Frontend performance
**PR:** split from #772 (slice B of 5: A lazy routes, B request dedup, C hover to CSS, D refactors, E runtime)
**Branch:** `perf/772-b-dedup`

- `lib/session-events.ts` is a dependency-free `onSessionEnd` / `emitSessionEnd` pub/sub (it must
  not import `authProvider`, which would create an `api` <-> `authProvider` cycle). `authProvider`
  emits it first in `logout()`, on `addUserUnloaded` and `addAccessTokenExpired`, and from
  `silentRefresh()` when the refresh returns no token or the server rejects it (oidc-client-ts
  `ErrorResponse`). A network error, `TypeError` or `ErrorTimeout` is transient and does not emit.
- `fetchUsersShared()` is single-flight with a 60 s cache and a generation counter, so a request
  that started before a clear can't repopulate the cache. It rejects on failure (not cached, so the
  next caller retries). It is not keyed by tenant: one identity per tab, a switch needs a full
  logout.
- `notifications-client` shares in-flight first-page and unread-count requests and clears them on
  mutation and on session end. No result cache.
- `WorkflowRecords` fetches fields, users and the first page of tickets together (4 round-trips to
  3). `appliedRecordsUrlRef` marks the URL whose response is applied, set only after a successful
  apply, so a failed first load is retried by the list effect and surfaces an error.
- `CustomerRecordDetail` uses the shared users cache and skips comments, attachments and tags when
  the record fails to load.
- Tests: `session-events`, `authProvider`, `use-users`, `user-ref-picker`, `notifications-client`,
  `workflow-records` and `record-detail` suites.
- Not in this slice: lazy routes, hover-to-CSS, the refactors, idle-logout and avatars (the other
  four PRs from the #772 split). Follow-up: `useUsers` has no callers yet outside tests.
