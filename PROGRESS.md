## 2026-07-23 — in-app-notification-hub / end-to-end pipeline smoke test attempt

### What I found before testing anything

The currently-running `ow-backend`/`ow-frontend` containers (up 5h, this repo's real dev
stack) are configured against a **real external hosted Zitadel** (`owzitadel.rokkalabs.com`
per `.env.local`'s active `ZITADEL_URL`/`ZITADEL_ISSUER`), not a local one. The repo also has
stopped `zitadel`/`zitadel-db` containers from a prior local-dev setup, but they're for a
*different*, currently-unused local config (the commented-out `# local` values in
`.env.local`) — starting them doesn't give a token the running backend would accept. Getting
a real browser-login JWT against the actual hosted Zitadel requires real credentials/browser
interaction I don't have safe access to attempt here. I started the local `zitadel`/
`zitadel-db` containers briefly to check this, confirmed the mismatch, then **stopped them
again** — environment left exactly as found (`docker ps` diffed before/after, identical).

### What I could and did verify — the real pipeline, no mocks

Since full HTTP+auth+browser e2e wasn't safely attainable, verified the actual highest-risk,
previously-unverified piece instead: **does the real worker pipeline (Phase 2's code, not a
mock) actually work against live Postgres + Redis?**

- Spun up fresh ephemeral `postgres:16-alpine` + `redis:7-alpine` (ports 5434/6381, isolated
  from every other container on this host), ran all migrations for real.
- Wrote a throwaway script (deleted after the run, never committed) that:
  1. Called the **real** `createEntityType`/`createEntity` (`@platform/entity-engine`) —
     not a hand-crafted outbox row — with an `assignedTo` set, exactly how the real API route
     would trigger this.
  2. Started the **real** `notification-poller.ts` (fast-polled at 500ms for the test only).
  3. Waited for the **real** `notification-worker.ts` to process it.
  4. Queried the real `notifications`/`notification_recipients` tables directly.
  5. Subscribed to the real `NOTIFICATION_PUSH_CHANNEL` via a real dedicated Redis
     subscriber connection (the same pattern `apps/api`'s websocket layer uses).
- **Result: all of it worked, unmodified, on the first meaningful run** (one test-script bug
  along the way — see below, not a pipeline bug):
  - Real `entity.assigned` outbox event written by `createEntity`.
  - Real poller claimed it via `notified_delivered_at` within one poll cycle.
  - Real worker resolved the recipient, wrote a real `notifications` row + one
    `notification_recipients` row for the assignee.
  - **Unprompted proof of R17** (deleted/unresolvable actor → placeholder): the actor
    (`e2e-actor`) was never in `tenant_users`, and the notification correctly rendered
    `"A user assigned you a ticket"` — this wasn't something the test script asserted for,
    it just happened to be true because the actor genuinely didn't exist, and the fallback
    fired exactly as designed.
  - Real link built correctly: `/records/<slugified-entity-type-name>/<instanceId>`.
  - Real outbound worker ran, correctly logged "no `NOTIFICATION_SERVICE_URL` configured —
    treating as a no-op" (harmless — it did attempt one real, read-only service-account token
    exchange against the hosted Zitadel via the already-configured credentials in `.env.local`,
    since `getUserById` doesn't know it's in a test), and marked `outboundStatus: 'sent'`.
  - Real Redis pub/sub push message received with the exact expected shape.
- **One bug caught in the test script itself, not the product code**: my first query for the
  outbox row's claim column used `.limit(1)` filtered only by `tenantId`, which non-
  deterministically could grab the *other* outbox row `createEntity` also writes
  (`entity.created` — correctly never claimed by the notification poller, since it's not one
  of the 6 trigger types). Fixed by also filtering `eventType = 'entity.assigned'`; re-ran,
  confirmed `notified_delivered_at` was in fact set.
- Cleaned up: deleted the throwaway script, removed both ephemeral containers.

### Still not verified (being honest about the actual remaining gap)

- The websocket handshake's JWT verification (`apps/api/src/websocket/notifications.ts`) —
  needs a real, valid Zitadel-issued access token, which requires either real hosted-Zitadel
  login credentials or a local Zitadel instance actually wired to the running backend. Neither
  was safely available this session.
- `apps/api`'s Redis-subscriber-side forwarding (receiving the push and routing to a live
  browser WebSocket connection) — the *publish* side is now proven real; the *subscribe +
  forward* side in `apps/api` still rests on code-review confidence, not an observed run.
- The UI (T8) itself, in a browser.

### Verification

- This was a manual, one-off verification run — not a repeatable automated test, and
  deliberately not added to the permanent suite (throwaway script, deleted).
- No regressions: this session made no source changes, only ran existing code against
  ephemeral infra.

### Next

The realistic path to closing the two remaining gaps above is either (a) getting real
hosted-Zitadel demo credentials safely into this environment, or (b) standing up the
commented-out local Zitadel config end-to-end (register the OIDC client + demo users against
the *local* `zitadel` container, then point a throwaway env override at it) — neither attempted
here since both are bigger asks than "attempt a smoke test." Recommend deciding which path
before treating this feature as fully shipped.

---

## 2026-07-23 — in-app-notification-hub / T8 (UI) + repo cleanup (portal removed)

### Done — repo cleanup (unrelated to the notification hub, requested mid-session)

- User confirmed there is no separate customer portal — `apps/admin-ui` (port 3001) serves
  both admin/agent and customer users via internal RBAC. This contradicted `CLAUDE.md`,
  `.claude/context/phase-2-primer.md`, and `.claude/skills/pre-pr-review/SKILL.md`, all fixed.
- **Deleted `apps/portal`** entirely (confirmed stale — `docker-compose.yml` already had a
  comment saying "admin + portal in one app"; no code anywhere imports `@platform/portal`).
  Removed via `git rm` (tracked files) + `rm -rf` (leftover untracked `dist`/`node_modules`/
  `.turbo`). `pnpm install` re-run to regenerate the lockfile — 29 workspace projects, down
  from 30.
- **Flagged, not fixed**: `.github/workflows/ci.yml`'s build matrix (`app: [api, worker,
  admin-ui, portal]`) still references `portal` — I can't edit that file (CLAUDE.md
  off-limits). CI will fail building a directory that no longer exists until the user removes
  that matrix entry.
- Explicitly did **not** rename `admin-ui` → `frontend` — user decided to keep the existing
  name after I scoped out what the rename would touch.

### Done — T8: notification bell/popup UI (`apps/admin-ui` only — no portal to also build for)

- `apps/admin-ui/src/lib/notifications-client.ts`: `listNotifications` (keyset cursor),
  `markNotificationRead`, `markAllNotificationsRead` (thin wrappers over the T7 API), plus
  `subscribeToNotifications` — a reconnecting-with-backoff WebSocket client. JWT passed as a
  `?token=` query param (browsers can't set custom WS handshake headers); token pulled fresh
  from `userManager.getUser()` on every (re)connect attempt, not cached, so a token refresh
  is picked up automatically on the next reconnect.
- `apps/admin-ui/src/components/notification-bell.tsx`: bell icon + unread badge + dropdown
  (latest 10, load-more, mark-all-read, click-to-navigate via `react-router`'s `useNavigate`,
  urgent red styling for `system.error`). Wired into `components/layout.tsx`'s shared topnav,
  next to the existing profile menu — same inline-style + `var(--...)` CSS-variable
  conventions already used there, no new design system introduced.
  **Known simplification**: the unread badge count is derived only from the currently-loaded
  page (latest 10 + whatever's been loaded via "load more" this session) plus live pushes,
  not a dedicated server-side unread-count query — T7 didn't build one. Reasonable for an
  active session (new unread items always arrive via push while the tab is open) but will
  undercount a user's true backlog on a fresh page load if they have more than 10 unread
  from before this session. Flagging as a real gap, not a silent shortcut.
- `apps/admin-ui/vite.config.ts`: added a `/ws` dev-proxy entry (`ws: true`) alongside the
  existing `/api` one — required for the websocket to reach `apps/api` through
  `docker-compose.yml`'s actual dev setup (`VITE_API_PROXY_TARGET`, confirmed this is the real
  running path, not the separate static-`serve` production Dockerfile, which has no reverse
  proxy for either route and appears to expect an external layer not present in this repo).
- New test: `apps/admin-ui/src/lib/notifications-client.test.ts` (4 tests, mocking
  `fetchWithAuth` — matches this codebase's existing `.test.ts`-only convention; no
  `.test.tsx`/React-render tests exist anywhere in `apps/admin-ui` yet, so didn't introduce
  that pattern unilaterally for just this one component).

### Verification

- `pnpm typecheck` (full monorepo, all 40 packages via turbo): PASS
- `pnpm --filter @platform/admin-ui test`: PASS, 50/50 (46 pre-existing + 4 new)
- No live end-to-end check of the websocket against a running `docker compose` stack this
  session (would need the full stack up, including a real Zitadel token) — carrying forward
  as the same open flag from Phase 2's PROGRESS entry, now doubly true since the UI side is
  built too.

### Next

This completes all of T1–T11 from `docs/specs/in-app-notification-hub-tasks.md`. Remaining
before this is truly done, not just "coded":
1. A real end-to-end smoke test against `docker compose up` (login, trigger a notification,
   see it arrive live, mark read, reload and see it persisted) — nothing this session verified
   the full stack wired together, only isolated layers (DB isolation tests, unit tests,
   typecheck).
2. `/security-review` on the Zitadel-client relocation (`packages/auth/src/
   zitadel-management.ts`) and the new websocket auth path (JWT-via-query-param).
3. A conscious decision on `executeNotifyAction`'s retry-can-double-fire limitation (T10).
4. The user needs to remove `portal` from `.github/workflows/ci.yml`'s build matrix.
5. Unread-badge-count simplification noted above — decide if a dedicated count endpoint is
   worth adding.

### Open questions

- None blocking, but items 1–3 above are real "is this actually done" gates, not nice-to-haves
  — recommend not marking this feature shipped until at least the end-to-end smoke test runs.

---

## 2026-07-23 — in-app-notification-hub / Phase 3 (T9–T11 done, T8 UI not started)

### Done

- **T9 — system-logs viewer** (`apps/api/src/routes/admin/system-logs.ts`): `GET
  /admin/system-logs`, admin-only, keyset-paginated over `notifications WHERE type =
  'system.error'`. Deliberately minimal per spec — a raw list, not a log/observability
  product.
- **T10 — retired the `executeNotifyAction` stub**
  (`packages/automation-engine/src/actions/notify.ts`): now async, writes directly into the
  same `notifications`/`notification_recipients` tables the 6 system triggers use (same
  read/unread UX, same websocket push via the outbound queue's jobId, same outbound handoff),
  instead of only logging. Content comes from the automation rule's own `payload` config
  (title/body/link), not a hardcoded template — a tenant-authored rule is already
  admin-configured content, unlike the 6 fixed system triggers. New `automation.notify`
  notification type required extending `notifications`' CHECK constraint (migration
  `0037_notifications_automation_type.sql`). `executor.ts`'s `notify` case now `await`s the
  action and passes the existing `redis` connection through (same one already threaded in for
  the circuit breaker) so it can enqueue the outbound job.
  **Known, documented limitation**: this notification's id is a fresh `randomUUID()`, not
  derived from a stable outbox-event id like the 6 system triggers — so unlike those, a BullMQ
  retry of the whole automation job could fire this action twice. Not fixed now (lower-value
  for a Phase 3, already-a-stub action); flagged in the code comment and here.
- **T11 — isolation tests** (`apps/api/tests/isolation/notifications.isolation.test.ts`):
  cross-tenant RLS on both new tables, `WITH CHECK` rejecting a mismatched `tenant_id`, and —
  importantly — the unique-constraint idempotency guarantee (R1/R16) verified as a real DB
  rejection, not just asserted in a mock. **Actually run against a live stack**, not just
  typechecked: spun up ephemeral `postgres:16-alpine` + `redis:7-alpine` on ports 5433/6380
  (avoiding the already-bound 5432/6432 from other running containers, left untouched),
  applied all migrations for real, ran both the new file and the **full existing isolation
  suite** to confirm nothing regressed, then tore the containers down.

### Verification

- pnpm typecheck (`@platform/db`, `@platform/auth`, `@platform/automation-engine`,
  `@platform/worker`, `api`): PASS
- pnpm lint: N/A — issue #141, still a repo-wide no-op
- pnpm test: `@platform/auth` 46/46, `@platform/automation-engine` 57/57 (up from 52 — 5 new in
  `notify.test.ts`), `@platform/worker` 58/58 (unchanged this round)
- pnpm test:isolation: **PASS, 162/162** (up from 155 — 7 new), run for real against the
  ephemeral stack described above, not skipped/deferred this time
- Confirmed via the isolation run itself that the new async `notify` action doesn't break the
  existing helpdesk-seed automation rule path (log line: "Automation: notify action has no
  recipientId configured — skipping" — expected, that seed rule's config has no `recipientId`)

### Next

T8 — the notification bell/popup UI in `apps/admin-ui` (and `apps/portal` if in scope) —
websocket client, unread badge, latest-10 + load-more list, mark-all-read, urgent styling for
`system.error`, click-to-navigate. Not started. This is the largest remaining piece and spans
a different stack (React/frontend) from everything done so far — stopping here to check in
before starting it, per the phased plan.

### Open questions

- None blocking. Carrying forward the two Phase 2 flags (Zitadel-client relocation deserves a
  `/security-review` look; the websocket+Redis cross-process wiring still has no live
  end-to-end check, only unit-level and now DB-isolation-level verification).
- New from this round: the `executeNotifyAction` double-fire-on-retry limitation (see T10
  above) — worth a conscious decision (fix now vs. accept) before this ships, not a silent gap.

---

## 2026-07-23 — in-app-notification-hub / Phase 2

### Done

Delivery engine: outbox events become in-app notifications, delivered live over websocket,
with a de-duped, retried handoff to the (still externally undecided) outbound service.

- **Design blocker resolved mid-session** (see conversation, not just this file): role
  membership (e.g. "who is a tenant admin") isn't queryable from our DB — it's a Zitadel
  JWT-only claim. Resolved per user direction: `system.error` recipients come from a single
  hardcoded `SYSTEM_ADMIN_USER_ID` config value (`packages/config/src/env.ts`), editable at
  any time, not a real role query. Real role-based resolution is deferred, not built.
- **Structural fix this required**: `apps/api/src/lib/zitadel-management.ts` (token handling,
  `getUserById`, `listOrgUsers`) moved to `packages/auth/src/zitadel-management.ts` so
  `apps/worker` (a separate app, can't import from `apps/api` per the dependency rule) can
  resolve a recipient's email for the outbound handoff. `apps/api`'s old path is now a
  re-export shim — its 4 existing call sites and their test mocks are unchanged. Added `phone`
  parsing to `OrgUser`/`getUserById` while touching this file (Zitadel's `human.phone.phone`
  was never read before) — unused today (sms/whatsapp are both `false`) but ready for later.
  Moved `zitadel-management.test.ts` alongside the real implementation.
- **T4 — in-app notifier** (`apps/worker/src/notification-poller.ts`,
  `notification-worker.ts`, `notification-recipients.ts`, `notification-templates.ts`):
  - Poller claims outbox rows via the new `notified_delivered_at` column (from Phase 1),
    completely independent of the automation engine's `delivered_at` claim — no race.
  - `resolveRecipients`: per-trigger-type resolution as a live snapshot at processing time
    (not cached from event-creation time) — entity.assigned → assignee; comment.mentioned →
    explicitly mentioned users only; access.granted/revoked → target user; workflow.sla_breached
    → `workflows.createdBy` + `assignedTo` (workflow admins, resolved fresh); system.error →
    the configured admin, gated on actual tenant membership. Self-suppression (actor never
    notified about their own action) applied uniformly in one `finalize()` helper.
  - **Idempotency fix caught before it shipped**: the notification's `id` is deterministically
    the outbox event's own id, not a fresh random UUID — a naive random-UUID-per-attempt would
    have defeated the `(notification_id, user_id)` unique constraint entirely on a BullMQ retry
    (each retry would insert under a new id). `onConflictDoNothing()` on both inserts makes a
    retry a true no-op.
  - Templates hardcoded per trigger type (`notification-templates.ts`); link building
    replicates `apps/admin-ui/src/entity-type-context.tsx`'s `toTypeSlug` exactly (no stored
    slug column exists — the frontend derives one from `entity_types.name`, so the backend
    must derive the same value or links 404).
  - Live push is Redis pub/sub (`NOTIFICATION_PUSH_CHANNEL`, `packages/redis`), not an
    in-process call — **also a design gap the original spec didn't separate out**:
    apps/worker and apps/api are different processes/containers, so the worker can't reach
    apps/api's in-memory websocket connections directly. This channel is what the "single
    instance is fine for now, multi-instance fan-out deferred" note in the spec actually
    needed from day one, just for a different reason (cross-process, not cross-replica).
- **T5 — websocket layer** (`apps/api/src/websocket/notifications.ts`): embedded in
  `apps/api` via `server.on("upgrade", ...)` on the existing `@hono/node-server` instance — no
  new container/port. JWT passed as a `?token=` query param (browsers can't set custom
  WebSocket handshake headers). Connections keyed by `(tenantId, userId)` together per the
  spec's invariant. Subscribes to the Redis push channel above and forwards to matching local
  connections; `broadcastReadState` (used by the mark-read routes) re-broadcasts to a user's
  other open tabs — same mechanism, no separate code path.
- **T6 — outbound handoff** (`apps/worker/src/notification-outbound-worker.ts`):
  `dispatchOutbound` is the sole function touching the external service — POSTs to
  `NOTIFICATION_SERVICE_URL` if configured (unset = logged no-op, not a failure, since the
  service doesn't exist yet); channel flags hardcoded `{email: true, sms: false, whatsapp:
  false}` per user direction. De-dupe via an atomic `pending` → `attempted` claim on
  `notifications.outbound_status` (conditional UPDATE, 0 rows = already handled, skip). 3
  attempts/exponential backoff matches the automation-queue convention. Permanent failure (all
  attempts exhausted) writes a `system.error` outbox event rather than only logging — which
  flows through the same notification hub to notify tenant admins, not a separate path.
- **T7 — API** (`apps/api/src/routes/notifications/`): `GET /notifications` (keyset
  pagination by `(created_at, id)`, never offset — stable under concurrent inserts),
  `POST /notifications/:id/read` (idempotent — `COALESCE` keeps the original read time rather
  than 404ing on an already-read notification), `POST /notifications/mark-all-read` (single
  bulk UPDATE, not a loop).
- New env vars: `SYSTEM_ADMIN_USER_ID`, `NOTIFICATION_SERVICE_URL` (both optional).
- New deps: `ws`/`@types/ws` (apps/api), `@platform/auth` (apps/worker, for the moved Zitadel
  client), `zod` (packages/auth, needed by the moved file).

### Verification

- pnpm typecheck (`@platform/db`, `@platform/auth`, `@platform/automation-engine`,
  `@platform/worker`, `api`): PASS
- pnpm lint: N/A — issue #141, still a repo-wide no-op
- pnpm test: `@platform/auth` 46/46, `@platform/automation-engine` 52/52, `@platform/worker`
  58/58 (up from 45 — 13 new: `notification-recipients.test.ts`,
  `notification-templates.test.ts`), `api` src/ unit tests 285/285 (all pre-existing, confirms
  the zitadel-management move broke nothing)
- pnpm test:isolation: NOT RUN — same Docker/OrbStack gap as Phase 1; deferred to T11 (Phase 3)
- Websocket layer and outbound HTTP call have no live-service integration test in this
  session (would need the Docker stack + a running counterpart) — covered by typecheck +
  unit tests on the pure logic (recipient resolution, templates, de-dupe claim SQL shape)
  only. Flagging as a real gap to close before this is considered done, not just a nice-to-have.

### Next

Phase 3 (T8–T11): notification bell/popup UI (admin-ui + portal), minimal system-logs page,
retire the `executeNotifyAction` stub in `packages/automation-engine` to route through this
system, isolation tests (cross-tenant RLS on the new tables, idempotency under simulated
redelivery, self-suppression per trigger type). Per the loop instructions, stopping here.

### Open questions

- None blocking, but two things worth a deliberate look before shipping, not just noting:
  1. The Zitadel-client relocation (`packages/auth/src/zitadel-management.ts`) is exactly the
     kind of change `/security-review` should see — it didn't change behavior, but it moved a
     service-account-JWT-signing, external-API-calling module to a new package boundary.
  2. No end-to-end verification yet that the websocket handshake's JWT-from-query-param
     approach and the Redis pub/sub cross-process push actually work together against a real
     running stack — only unit-level pieces were verified this session.

---

## 2026-07-23 — in-app-notification-hub / Phase 1

### Done

- T1: Migration `0036_notifications.sql` — `notifications` + `notification_recipients` tables,
  RLS policies, tenant + keyset-pagination indexes, unique `(notification_id, user_id)` idempotency
  index, `outbound_status` de-dupe column, `app_user` grants. Also added a second, independent
  delivery-claim column `notified_delivered_at` on the existing `outbox_events` table (not in the
  original task list — see "Design deviation" below) with its own index. Journal updated
  (`packages/db/migrations/meta/_journal.json`). New Drizzle schema
  `packages/db/src/schema/notifications.ts`, exported from `schema/index.ts`.
- T2: New outbox event schemas + `TriggerType`s in `packages/automation-engine/src/event-schemas.ts`
  and `types.ts` — `comment.mentioned`, `access.granted`, `access.revoked`, `system.error`. Actor/user
  ids use plain `z.string()` (not `.uuid()`), matching the rest of the codebase's TEXT user-id
  columns (Zitadel sub claims aren't guaranteed UUIDs — see migration 0021).
- T3: Wired outbox writes —
  - `apps/api/src/routes/entities/add-comment.ts`: writes a `comment.mentioned` outbox event when
    `mentions.length > 0`.
  - `apps/api/src/lib/emit-access-event.ts`: writes `access.granted`/`access.revoked` outbox events
    for `access_grant`/`access_revoke` payload types only (`access_update`/`access_reject` have no
    corresponding event schema yet — out of scope per spec). This is the single choke point already
    shared by `grant-access.ts`, `revoke-access.ts`, `resolve-access-request.ts`, `update-access.ts`,
    so all four routes get outbox wiring through one change.
- Tests: updated `add-comment.test.ts`'s `@platform/db` mock (missing `outboxEvents` export caused a
  500). New `apps/api/src/lib/emit-access-event.test.ts` (no prior test file existed) covering
  granted/revoked outbox writes, the update/reject no-op, and the no-resolvable-workflow early return.

### Design deviation (flagged to human during session, not unilaterally decided)

The spec assumed Worker #1 (in-app notifier, Phase 2) would consume `outbox_events` directly. But
`apps/worker/src/outbox-poller.ts` already claims rows for the automation engine via `delivered_at` —
a single-consumer claim, not a broadcast. A second consumer sharing that column would race it (the
exact `workflow.sla_scheduled` failure mode documented in that file's own comments). Added a second
nullable column, `notified_delivered_at`, so the notification worker can independently claim rows
without touching the automation engine's claim column. Small additive change to an existing shared
table; explained to the user in-session before implementing.

### Verification

- pnpm typecheck (`@platform/db`, `@platform/automation-engine`, `api`): PASS
- pnpm lint: N/A — issue #141, `pnpm lint` is a repo-wide no-op today (no per-package lint scripts)
- pnpm test (automation-engine): PASS (52/52)
- pnpm test (api, scoped to touched files — add-comment, emit-access-event, grant-access,
  resolve-access-request): PASS (19/19)
- pnpm test:isolation: NOT RUN — Docker/OrbStack stack not up in this environment (`docker ps` shows
  only unrelated containers from other projects, left untouched). Isolation tests for the two new
  tables are T11 (Phase 3), not part of Phase 1's scope.
- Full `pnpm test` run showed unrelated pre-existing failures (modules/view-configs/upload-flow
  integration tests) — these require the DB/Redis stack too and are unconnected to this change.

### Next

Phase 2 (T4–T7): in-app notifier worker (recipient resolution, idempotent writes, templates),
websocket layer in `apps/api` (keyed by `(tenant_id, user_id)`), outbound-handoff worker (attempt
marker, 3 retries/backoff, `system.error` on permanent failure), notification API
(`GET /notifications`, mark-read, mark-all-read). Per the loop instructions, stopping here — Phase 2
not started.

### Open questions

- None blocking. The `notified_delivered_at` column addition should be called out again when this
  goes through `/review` given it touches an existing shared table outside this feature's own tables.

---

## 2026-07-10 — Security audit findings #8 and #9 (closes the full 2026-07-09 audit)

### Done

**#8 — introspection cache key upgraded from a 32-bit hash to SHA-256:**

- `packages/auth/src/introspection.ts`: `simpleHash` (djb2, 32-bit) replaced
  with `hashToken` (`createHash("sha256")`). A 32-bit hash has a large enough
  collision space (~4 billion buckets) that two distinct tokens could in
  theory hash to the same cache key, returning the wrong token's
  active/inactive introspection result for up to the 60s cache TTL.
- `packages/auth/src/introspection.test.ts`: +1 test proving two distinct
  tokens are cached independently (two real network calls, not one).

**#9 — `platform/users.ts` PII exposure to `user`-role callers: reviewed,
confirmed intentional, no code change.**

- Asked directly: `GET /users` returns every tenant member's
  email/displayName/loginName even to plain `user`-role (customer) callers.
  The code already documents this as deliberate (comment: "'user' role
  included: customers need this to resolve assignee display names on their
  records"). Confirmed with the user this is still the intended tradeoff —
  closing this out as reviewed, not a bug.

### Why

Last two items from the 2026-07-09 security audit's to-do list. Both
low-stakes: #8 is a defense-in-depth hardening (no confirmed exploit, just a
theoretical weakness in the cache key), #9 was a design question, not a code
issue.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run, clean)
- pnpm test: PASS — `@platform/auth` 36/36 (up from 35, +1 new). Root
  `@platform/api` failures unchanged at the established 12-test baseline.
- pnpm test:isolation: PASS (134/134, unaffected by this change).

### Audit closed out

This closes the entire 2026-07-09 security audit (#1-#10). Summary of what
shipped across the six fix sessions:

1. Record-level read access enforced on entity/attachment/file reads (`0c043a9`)
2. CSV/XLSX formula injection sanitized (`1e3114b`)
3. JWT audience validation made fail-closed (`e2745e3`)
4. Zitadel error-body logging removed from failure paths (`4b78110`)
5. Tenant-status cache cross-instance invalidation via Redis pub/sub (`9178e30`)
6. automation-rules routes repaired (was a live production outage, not just
   hardening) + entity-types mutation belt-and-suspenders (`6330aaa`)
7. (bundled with #6 above)
8. Introspection cache key hardened to SHA-256 (this session)
9. `users.ts` PII exposure reviewed and confirmed intentional (this session)
10. Follow-up sweep found and fixed 6 more routes broken by the same RLS
    pattern as #6: admin/audit, api-keys create/list/delete,
    view-configs GET/PATCH, set-child-status (`cf52595`)

**Biggest takeaway:** roughly half of what started as "hardening" findings
turned out to be actively broken production features (API key management,
audit log viewing, view-config customization, child-ticket status,
automation rules) — all silently failing since the #121 RLS enforcement fix,
all invisible to existing tests because they mock the DB layer entirely.
Worth raising with the team: a lint rule or codemod flagging
`db.select/insert/update/delete` on a known-RLS table outside
`withTenantContext` would catch this bug class automatically. Not
implemented — a process idea, not a coded fix.

### Next

No open items from this audit. Possible follow-ups if wanted:
- The lint-rule/codemod idea above, to prevent this bug class from recurring.
- A live, real-Zitadel-JWT-backed e2e smoke test suite, since several fixes
  in this audit could only be verified via the isolation-test technique
  (bypassing JWT verification) rather than a true end-to-end request —
  correct and sufficient, but a real JWT-based e2e pass would close that gap.

---

## 2026-07-16 — chore #146: upgrade pnpm 9 -> 11 (fix CI security-scan)

CI's Security scan job was failing repo-wide (confirmed identical failure on `main`, not
caused by any in-flight PR): npm retired the legacy `/-/npm/v1/security/audits` endpoint
(scheduled brownout completing 2026-07-15), and `pnpm audit` on any pnpm version through
10.x still calls it, returning 410. Filed as [#146](../../issues/146).

### Done

- Bumped `packageManager`/`engines.pnpm` from `9.15.9` to `11.13.0` — confirmed via
  pnpm's own docs that v11 switched `pnpm audit` to the new bulk advisory endpoint.
- Migrated `package.json`'s `pnpm.overrides` (typescript/esbuild/hono pins) to
  `pnpm-workspace.yaml`'s `overrides:` key — pnpm 11 silently stopped reading the old
  field (`[WARN] The "pnpm" field in package.json is no longer read...`). Preserved the
  esbuild `>=0.28.1` security pin (GHSA-gv7w-rqvm-qjhr) that CLAUDE.md says not to remove
  — added both changes in the same edit so the pin was never absent from the tree.
- Filled in pnpm 11's new `allowBuilds` prompt (`esbuild`, `msgpackr-extract` — both
  legitimate native-build deps) in `pnpm-workspace.yaml` so `pnpm install` doesn't need an
  interactive TTY prompt in CI.
- Updated `CLAUDE.md`'s maintenance note to point at the new override location.
- No `pnpm-lock.yaml` changes — same resolutions, only the CLI version changed.

### Verification

Ran twice: once in a throwaway worktree, once for real on this branch (the first run's
plan-lock approval attached to the wrong branch since the guardrail hooks resolve against
the primary checkout, not a worktree — redid the edits here instead). Both runs gave
identical results (turbo cache-confirmed byte-identical on the second pass):

- `pnpm audit --audit-level=high`: was `ERR_PNPM_AUDIT_BAD_RESPONSE` (410) — now exits 0,
  7 vulnerabilities found (2 low, 5 moderate), none high/critical.
- pnpm typecheck: PASS (40/40 tasks)
- pnpm lint: PASS (13/13 tasks — matches the known #141 no-op state, unaffected)
- pnpm test: 9/332 tests fail (4 files, all in `view-configs.test.ts`, 5s timeouts +
  one status-code assertion). **Confirmed pre-existing**: ran the identical test file
  against the unmodified `pnpm@9.15.9` checkout with the same ephemeral CI-matching
  Postgres/Redis containers — byte-identical failure. Not a regression from this change;
  looks like local sandbox I/O latency vs. GitHub Actions runners.
- pnpm test:isolation: PASS (123/123)
- Verified against ephemeral `postgres:16-alpine`/`redis:7-alpine` containers on
  ports 5433/6380 matching `.github/workflows/ci.yml`'s security/test job env exactly
  (not the long-lived `platform-postgres-1`/`platform-redis-1` dev containers, which have
  different credentials and caused an unrelated auth failure on first attempt). Removed
  after the run; left the pre-existing dev containers in their original (exited) state.

### Next

- Push branch, open PR referencing #146
- Once merged, re-check PR #145's CI (unrelated docs PR, blocked by this same repo-wide
  issue) — should go green without any change needed there once `main` has this fix

### Open questions

- None blocking.

---

## 2026-07-15 — PR #145 review round 2 (DOC-1 re-rejected, NEW-1/NEW-2 fixed)

Rechecked @PrabhuVijit's second validation pass on PR #145 rather than taking either side
on faith.

### Done

- **DOC-1 (re-verified, still rejected):** the reviewer repeated the claim that commit
  `2369723`'s message ("closes #120 and #123") proves #123 was fixed. Checked PR #139's
  actual commit list (`a72c66c4`, `821bbf44`, `286340a8` — `2369723` isn't among them),
  confirmed `2369723` is orphaned (`.../pulls` and `.../branches-where-head` both empty, not
  an ancestor of `main`), and confirmed in code that `automationQueue` in `queues.ts` still
  has no `defaultJobOptions` and `automation-worker.ts:58` still defaults `attempts` to 1.
  `gh issue view 123` confirms `OPEN`. Posted a stronger rebuttal on the PR citing the actual
  commit list instead of just the merge-base check from round 1.
- **NEW-1 (fixed):** the round-1 DOC-5 fix overcorrected the week-log session header from
  `2026-07-10` to `2026-07-09`, creating duplicate/misordered `## 2026-07-09` headers.
  Verified the reconciliation commit's real authored date (`2026-07-10T18:45:03Z` via
  `gh pr view 145 --json commits`) and reverted, rewording the title per the reviewer's
  suggestion.
- **NEW-2 (fixed):** week-log still described the ordering-slip note as "#120 already in
  flight before #126 finished," which now contradicted `CLAUDE.md`'s corrected wording.
  Reworded to match ("same review session, merged the same day").
- Committed as `7132eea`, pushed, replied on PR #145 with full evidence for both.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

- Await @PrabhuVijit's response on PR #145 (DOC-1 rebuttal + NEW-1/NEW-2 fixes)
- #127 — guard `setEntityState`/`bulkSetState` (audit/compliance side-door) — next hardening item
- #123 remains genuinely open — real fix (retry config on `automationQueue`) still needed,
  not just a doc update

### Open questions

- None blocking.

---

## 2026-07-09 — PR #139 human review round (all items fixed)

@PrabhuVijit reviewed PR #139 with 2 blockers and 6 non-blocking items.

- **STACK-1** (blocker): PR was based on the now-merged `fix/PLAT-126-entity-created-triggers`
  branch instead of `main`, so CI never ran (`ci.yml`'s `pull_request` trigger only matches
  `branches: [main, develop]`). Retargeted to `main`; cycled the PR closed/reopened to force a
  `synchronize` CI run since changing the base only fires `edited`.
- **POLLER-1** (blocker): `outbox-poller.ts`'s negative denylist repeated the exact failure
  pattern that caused the `workflow.sla_scheduled` bug — any future non-trigger outbox event
  type would silently break the same way by default. Switched to a positive allowlist of
  `TriggerEventSchema`'s 4 literal event types, with a comment cross-referencing
  `event-schemas.ts`.
- **POLLER-2**: `system.error` rows would now accumulate forever with `delivered_at IS NULL`
  since they're excluded from the (new) allowlist and have no consumer. `av-scan.ts` now sets
  `deliveredAt` at insert time — dead-letter by design, not a stale row nothing ever picks up.
- **TEST-1**: `automation-depth-recursion.isolation.test.ts`'s `afterAll` now also deletes
  `automationExecutions` for the test tenant.
- **TEST-2**: `entity-assigned-depth.isolation.test.ts`'s outbox cleanup moved into `afterAll`
  so it runs unconditionally even if an earlier assertion throws.
- **VITEST-1**: added the missing `@platform/automation-engine` vitest resolve alias to
  `apps/api/vitest.config.ts` (matches entity-engine/workflow-engine) — this was the source of
  the stale-dist debugging cost flagged in the #120 session's own Next list.
- **DEPTH-LEAK-1**: `executor.ts`'s `eventFields` merge now strips `version`/`tenantId`/`depth`
  before condition-tree evaluation, so a tenant-authored condition can no longer match on the
  internal recursion counter.
- **ARCH-1**: filed [#143](../../issues/143) tracking that automation-triggered transitions are
  absent from the outbox (a Phase 3A connector-design gap) — reviewer recommended filing rather
  than fixing now, since there's no connector consumer yet.

### Verification

- pnpm typecheck: PASS
- pnpm test: PASS (332/332)
- pnpm test:isolation: PASS (123/123)
- Diff-scoped `eslint --max-warnings=0`: clean

### Next

- Watch PR #139 CI, then merge
- #127, #123–#125, #128, #129 remain open
- #136 — RLS policies for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`
- #141 — `pnpm lint` no-op needs its own session
- #143 — Phase 3A connector design must account for the outbox/workflow_events gap

---

## 2026-07-08 — Hardening #120: automation double-trigger / depth-reset

### Done

Research first established this is actually two related bugs, not one:
1. **Real double-execution**: the `transition` automation action both writes a
   `workflow.transitioned` outbox row *and* recurses in-process for the same event —
   any matching rule fired twice, independent of recursion depth.
2. **Unbounded outbox-routed recursion**: `apps/worker/src/automation-worker.ts` hardcoded
   `depth=0` for every dequeued outbox job, so `MAX_DEPTH` (10) never bounded a chain that
   loops purely through the outbox. Affects the `transition` action (per #120's title) and a
   second, previously-undocumented instance: `set_field` -> `updateEntity` ->
   `entity.assigned`, which has no in-process fallback at all.

Fixes (design confirmed with the user before implementing — see the double-trigger question):

- `packages/workflow-engine/src/engine.ts`: `executeTransition` now skips the
  `workflow.transitioned` outbox write when `request.triggeredBy === "automation"`.
  Automation-triggered transitions rely solely on the existing, correctly-bounded in-process
  `depth+1` recursion in `transition.ts`. User/API/system-triggered transitions keep writing
  to the outbox unchanged (they have no in-process recursion, so they still need it to reach
  automation at all). This closes the double-execution bug *and*, as a side effect, fully
  closes the "transition via outbox" loop scenario (automation-triggered transitions no
  longer touch the outbox at all).
- `packages/automation-engine/src/event-schemas.ts`: added optional `depth?: number` to
  `baseEvent`, inherited by all 4 discriminated `TriggerEventSchema` variants.
- `packages/entity-engine/src/types.ts`/`engine.ts`: `updateEntity` accepts a new optional
  `depth` input; when present, the resulting `entity.assigned` outbox payload carries
  `depth + 1` (mirroring `transition.ts`'s convention).
- `packages/automation-engine/src/actions/set-field.ts` / `executor.ts`: `executeSetFieldAction`
  now receives and forwards `depth` to `updateEntity`.
- `apps/worker/src/automation-worker.ts`: reads `payload.depth ?? 0` instead of hardcoding
  `0` when dequeuing outbox-routed jobs — this is what actually lets `MAX_DEPTH` enforcement
  survive the async outbox hop.

**Found and fixed a third, more severe, unrelated bug while investigating AC5** (whether
`workflow.sla_scheduled` — not part of `TriggerEventSchema`'s union — causes issues when
dequeued): `apps/worker/src/outbox-poller.ts`'s query had no `event_type` filter, so it
raced `apps/worker/src/sla-scheduler.ts`'s dedicated, filtered query for the exact same
`workflow.sla_scheduled` rows. Given `outbox-poller.ts` polls every 2s vs. `sla-scheduler.ts`'s
10s, it usually wins the `FOR UPDATE SKIP LOCKED` race, marks the row delivered, and hands it
to `automationWorker` — which rejects it with `INVALID_EVENT_PAYLOAD` (it's not one of the 4
schema variants) — so `sla-scheduler.ts` never sees the row again and **the SLA breach check
for that state transition is silently never scheduled**. This looks like it's been live since
the dual-poller architecture was introduced. Fixed by excluding `workflow.sla_scheduled` from
`outbox-poller.ts`'s query, mirroring `sla-scheduler.ts`'s own specific-inclusion filter.

**Notable finding while writing the Prove-It test for AC3**: no *current* automation action
can actually reach the `set_field` -> `entity.assigned` recursion path, because `set_field`
only ever writes to `input.fields`, never `input.assignedTo` — there is no `assign` action
implemented yet (the `ActionType` union has the literal but `executor.ts`'s switch never
handles it). So the depth-carrying fix for this path is defensive/forward-looking plumbing,
not closing a path that's live today — unlike the `transition` double-trigger, which is a
real, currently-reachable bug. Documented so this isn't mistaken for "already exploited."

**Process note — stale dist caught late**: `apps/api/vitest.config.ts` aliases
`@platform/entity-engine` and `@platform/workflow-engine` to source directly, but has no
alias for `@platform/automation-engine` — so isolation tests were silently running against
its last-built `dist/` output, not my source edits, until `pnpm --filter @platform/automation-engine build`
was run. Cost real debugging time (added and removed temporary `console.log`s chasing a
"fix that wasn't taking effect" before finding the missing alias) — worth a follow-up to add
the missing vitest alias so this doesn't happen again for automation-engine specifically.

### /code-review findings (8-angle fan-out) — fixed before shipping

- **`bulkUpdateEntities` never passed `input.depth`** to the `entity.assigned` outbox payload
  in either of its two branches, unlike the two `updateEntity` branches this PR already fixed
  — both use the identical `UpdateEntityInput` type. Added `input.depth` to both call sites
  for consistency, even though (like `updateEntity`'s own path) nothing currently reaches it.
- **The `system.error` outbox event type has the exact same misrouting bug** I found and fixed
  for `workflow.sla_scheduled`: `apps/worker/src/outbox-poller.ts` had no `event_type` filter
  before this PR, so it would also claim `system.error` rows (written by `av-scan.ts` on final
  scan failure) and hand them to `automationWorker`, which rejects them with
  `INVALID_EVENT_PAYLOAD` since they're not part of `TriggerEventSchema`. Folded into the same
  exclusion filter (`NOT IN ('workflow.sla_scheduled', 'system.error')`) with an explanatory
  comment, since `system.error` has no dedicated consumer to race against — it just needs to
  not be sent to automation at all.
- **`readDepth()` in `automation-worker.ts` hand-rolled the exact `int, >=0` constraint already
  declared as a Zod field** in `event-schemas.ts`'s `baseEvent`, duplicating validation logic
  the codebase already centralizes there — and its manual `as {depth: unknown}` casts lacked
  the code-style-required inline comment explaining why. Fixed by exporting a small
  `OutboxDepthSchema` (`baseEvent.pick({ depth: true }).passthrough()`) from
  `event-schemas.ts` and using `OutboxDepthSchema.safeParse(payload).data?.depth ?? 0` —
  cuts ~15 lines to 3, removes the duplicated constraint, and removes the bare casts entirely.
- **Isolation test file was 228 lines covering two logical concerns** (the live double-trigger
  fix and the not-yet-reachable depth-carrying plumbing) — split into
  `automation-depth-recursion.isolation.test.ts` (double-trigger, 1 test) and
  `entity-assigned-depth.isolation.test.ts` (depth-carrying, 1 test).

Declined to fix (documented instead):
- **`triggeredBy` is now overloaded** for both attribution/audit *and* the outbox-delivery
  decision (`if (triggeredBy !== "automation")`) — a future 5th `triggeredBy` value (e.g. a
  Phase 3 "connector" origin) has no structural signal that it must also reconsider this
  condition. No concrete bug today; the existing inline comment already documents the
  reasoning for anyone touching this later.
- **`depth` lives on the shared domain event schema** (`baseEvent`) rather than as
  transport-only envelope metadata, so it's visible to `executor.ts`'s `eventFields` merge and
  could theoretically be referenced in a tenant-configured condition tree (e.g. "only run if
  depth > 3"). Not a security or correctness issue — separating payload from envelope
  metadata throughout the outbox/executor pipeline is a real refactor, out of scope here.

### Verification (CI-equivalent local run, same method as prior sessions)

- pnpm typecheck: PASS
- pnpm test: PASS (329/329, up from 327)
- pnpm test:isolation: PASS (120/120, up from 118 — 2 new tests, split across
  `automation-depth-recursion.isolation.test.ts` and `entity-assigned-depth.isolation.test.ts`.
  Prove-It Pattern: written to fail on unfixed code, confirmed passing after the fix,
  including catching my own stale-dist false negative along the way)

### Next

1. Doc/follow-up: add `@platform/automation-engine` to `apps/api/vitest.config.ts`'s
   resolve aliases (matches entity-engine/workflow-engine already there) — prevents the
   stale-dist trap hit this session
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Remaining hardening items #123, #124, #125, #128, #129
4. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions`

### Open questions

- None blocking. The `set_field`/`entity.assigned` depth plumbing is genuinely unreachable
  by any current action — flagged above, not treated as a live exploit.

---

## 2026-07-08 — PR #138 human review round (all items fixed)

@PrabhuVijit reviewed PR #138 with 1 blocker and 6 non-blocking items; user asked to fix
all of them.

- **REDACT-1 (blocker)**: `bulkCreateEntities`'s `getSensitivityMap` fell back to `?? []`
  if a type was somehow missing from `typeMetaCache` — an empty sensitivity map means
  `redactFields` redacts nothing, failing open on a security property. Changed to throw
  `EntityError("ENTITY_TYPE_NOT_FOUND")` instead; the fallback was unreachable in practice
  but "unreachable fallback that fails open on PII redaction" is exactly the bug class to
  not leave in place.
- **TEST-CLEANUP-1**: `entity-created-trigger.isolation.test.ts`'s `afterAll` now also
  deletes `automationExecutions` for the test tenant (was only deleting `outboxEvents`) —
  local re-runs against a non-fresh DB were accumulating execution rows.
- **BULK-TEST-1**: added `apps/api/tests/isolation/bulk-entity-triggers.isolation.test.ts` —
  real-DB tests proving `bulkCreateEntities` writes correctly-redacted `entity.created` rows
  and `bulkUpdateEntities` fires `entity.assigned` only for items whose assignee actually
  changed. The existing `bulk.test.ts` unit tests only checked `db.insert` call counts via
  mocks, not payload shape or queryability.
- **REDACT-INTERNAL**: documented in `redact.ts` why `internal`-sensitivity fields are
  deliberately not redacted from the outbox (automation rules — including webhook actions —
  are admin-only configured, the same trust level that already has direct read access to
  `internal` fields via the entity API).
- **EVENT-SCHEMA-DRIFT**: added a "MUST MATCH" comment in `entity-engine/src/types.ts`
  naming the exact automation-engine schema these local interfaces have to track, plus a new
  isolation test asserting a real `entity.created` outbox row parses cleanly against
  automation-engine's actual `TriggerEventSchema` — catches drift at test time instead of
  in production silently killing every `entity.created` rule.
- **SEED-VALIDATION**: `apps/api/src/routes/automation-rules/schemas.ts`'s `ActionConfigSchema`
  was a loose `{type: enum, config: z.record(unknown)}` — upgraded to a real discriminated
  union with per-type config shapes (`set_field`, `transition`, `webhook` get their actual
  field constraints; the 4 unimplemented `ActionType` variants stay permissive since their
  shape doesn't exist yet). This only protects API-created/updated rules — module seed SQL
  bypasses it entirely (raw INSERT), so also added matching comments in
  `modules/helpdesk/seed/003_automation_rules.sql` and `executor.ts`'s `runAction` pointing
  each at the other, since there's no automated check for the seed-SQL side of this gap.
- **LINT-1**: filed [#141](../../issues/141) for the `pnpm lint` no-op found in the prior
  review round, instead of leaving it as a PROGRESS.md note.

### Verification

- pnpm typecheck: PASS
- pnpm test: PASS (330/330, up from 327)
- pnpm test:isolation: PASS (121/121, up from 118 — 3 new tests: schema-drift-detection,
  bulk-create redaction, bulk-update selective entity.assigned)
- Diff-scoped `eslint --max-warnings=0`: clean

### Next

- #141 needs its own session (adding real `lint` scripts across every `package.json`)
- Everything else from the original #126/#120 session's "Next" list still applies

---

## 2026-07-08 — Hardening #126: entity.created / entity.assigned triggers

### Done

- `packages/entity-engine/src/types.ts`: added local `EntityCreatedEvent`/`EntityAssignedEvent`
  interfaces (plain TS, no cross-package import — entity-engine may only depend on `db` per
  CLAUDE.md's dependency rule; automation-engine already depends on entity-engine, so the
  reverse import would be a cycle). Mirrors how `workflow-engine` defines
  `WorkflowTransitionedEvent` locally rather than importing automation-engine's zod schema.
- `packages/entity-engine/src/engine.ts`: `createEntity`, `updateEntity` (both branches),
  `bulkCreateEntities`, and `bulkUpdateEntities` now write `entity.created`/`entity.assigned`
  rows to `outbox_events` in the same transaction. Closes #126.
  - `entity.assigned` fires on any transition to a new non-null assignee — both
    create-with-assignee and reassignment via update (confirmed with the user; the schema's
    non-nullable `assigneeId` can't represent unassignment, so that case doesn't fire).
  - Flagged with a code comment: this is the first path that makes #120's unbounded
    outbox-routed automation recursion actually reachable (entity.created/assigned rules can
    chain into create/update actions). Not fixed here — #120 stays out of scope.
- **Found and fixed an adjacent bug while writing the Prove-It test**:
  `modules/helpdesk/seed/003_automation_rules.sql`'s "auto-set priority" rule — the exact
  example the consulting review cited as "silently does nothing" — used the wrong action
  shape entirely: `{"type": "set-field", "field": ..., "value": ...}` when the executor's
  `case "set_field"` expects `{"type": "set_field", "config": {"field": ..., "value": ...}}`.
  Without this fix, the rule would have kept silently doing nothing after #126 landed, just
  for a different reason. One-line seed SQL data fix, no schema/API change.
- New isolation test `apps/api/tests/isolation/entity-created-trigger.isolation.test.ts` (5
  tests) — Prove-It Pattern: written first, confirmed failing against unfixed `engine.ts`
  (verified via `git stash` on just that file), confirmed passing after the fix. Proves the
  full chain end-to-end: create an entity → real `outbox_events` row written → handed to
  `executeAutomationRules` exactly as the outbox poller would → the helpdesk-style
  `set_field` rule actually applies the field change. Also covers entity.assigned on create
  and on reassignment, and that re-assigning to the same assignee doesn't re-fire.
- Updated `engine.test.ts`/`bulk.test.ts` mocks and call-count assertions for the new
  `outboxEvents` inserts (2 pre-existing `bulkCreateEntities` assertions needed
  `toHaveBeenCalledTimes(1)` → `(2)`, since bulk create now does one batched insert into
  `entityInstances` plus one batched insert into `outboxEvents`).
- Branch: `fix/PLAT-126-entity-created-triggers`. Plan-lock approved by human before any
  source edit; the `entity.assigned` semantics question (see above) was asked and answered
  before drafting the plan, since the docs didn't disambiguate and the schema can't
  represent every option.

### /security-review finding (fixed before shipping): PII leaves the platform via the new outbox path

The security review flagged that `entity.created`'s outbox payload carried the entity's full,
unredacted field map (`fieldsWithFormulas`) — including `pii`/`financial`-classified fields —
whereas every other secondary store that persists field values (`workflow_events.metadata`,
`admin_audit_log`) redacts them first. Since `entity.created` never fired before this PR, this
was the first path that let raw PII reach a table an admin-configured `webhook` automation
action can forward to an external URL. Adversarially verified as real (not pre-existing —
confirmed the entire outbox-insert block is new in this diff).

Fixed: added `packages/entity-engine/src/redact.ts` (`redactFields`/`buildSensitivityMap`,
same contract as `workflow-engine`'s equivalent, defined locally rather than imported —
same dependency-direction reason as the event types above) and applied it to the `fields`
value in both `createEntity`'s and `bulkCreateEntities`'s outbox payloads before insert.

**While writing the Prove-It test for this fix, found a second, unrelated pre-existing bug**:
`addEntityField` (`packages/entity-engine/src/engine.ts`) accepts a `sensitivity` parameter
and threads it through the whole call chain — including the real API route
(`POST /entity-types/:id/fields`, `apps/api/src/routes/entity-types/fields/create-field.ts`,
already correctly forwarding `input.sensitivity`) — but its DB insert never actually included
the `sensitivity` column, so every custom field ever created via that route silently fell back
to the column default (`'internal'`), regardless of what the caller specified. This meant any
tenant admin who marked a custom field `pii` or `financial` today gets none of the redaction
protection everywhere that classification is supposed to enable — a bigger, platform-wide gap
than the outbox-specific one above. No existing test caught it because the only test touching
`sensitivity` (`audit-hook.test.ts`) mocks field metadata directly rather than exercising the
real insert. One-line fix: added the missing `sensitivity: field.sensitivity` to the insert
`.values()`. The new isolation test's redaction case exercises this real path end-to-end
(creates the field via `addEntityField` with `sensitivity: "pii"`, then asserts redaction),
so it doubles as the regression test for both bugs together.

### /code-review findings (8-angle fan-out) — fixed before shipping

- **`workflow_events.metadata` still leaked raw PII, and my own code comment falsely claimed
  it didn't.** The first redaction fix only covered the new `entity.created` outbox path;
  `createEntity`'s pre-existing `workflow_events` insert (for workflow-attached entities) and
  `updateEntity`'s field-diff (`changed[key] = {old, new}`) both still wrote raw field values.
  Fixed both: `createEntity` now redacts once and reuses the result for both writes;
  `updateEntity`'s diff now computes on **raw** values (redacting first would make every
  pii/financial change look like a no-op, since both sides collapse to the same
  `"[REDACTED]"` string) and redacts only what gets stored.
- **`assignedBy` on `entity.assigned` was computed inconsistently across all 6 call sites** —
  `createEntity` used `actorId ?? createdBy`, `updateEntity`'s two branches and
  `bulkUpdateEntities`'s two branches used `actorId ?? null` (dropping the creator fallback),
  and `bulkCreateEntities` used `createdBy` alone (dropping `actorId` entirely — it never had
  access to it, since the per-row `auditMeta` didn't carry it). Extracted a single
  `resolveAssignedBy(actorId, createdBy)` and used it everywhere, and added `actorId` to
  `bulkCreateEntities`'s parallel `auditMeta` array so the real actor is available per row.
- **`bulkCreateEntities`'s outbox flatMap rebuilt a sensitivity map per row** instead of using
  the function's existing per-type cache (`typeMetaCache`) — hoisted to a `getSensitivityMap`
  helper keyed by `entityTypeId`.
- **`bulkUpdateEntities` did one `outboxEvents` insert per item inside its `Promise.all`**
  instead of batching like `bulkCreateEntities` does — N round trips instead of 1 for a
  100-item bulk update. Collected rows into an array and moved the insert to after
  `Promise.all`.
- **Isolation test file exceeded testing-conventions.md's ~200-line split threshold** (264
  lines, two logical concerns). Split into
  `entity-created-trigger.isolation.test.ts` and `entity-assigned-trigger.isolation.test.ts`.

Declined to fix (documented instead):
- **#120 is now more exploitable, not just reachable**: `entity.created` fires on *every*
  entity creation with zero tenant configuration required, unlike `workflow.transitioned`
  which needs a deliberately configured multi-step workflow to loop. Still out of scope for
  #126 (approved plan boundary), but the severity note is worth carrying into whoever picks
  up #120 next.
- **Helpdesk seed's `WHERE NOT EXISTS` idempotency guard matches on rule name, not content**,
  so tenants that installed the module before this PR's action-shape fix keep the old broken
  payload forever (reseeding doesn't overwrite existing rows, and blindly overwriting could
  destroy a tenant's manual customization). Not fixed: no real tenants are onboarded yet
  (Phase 2 complete, pilot NOT YET per the consulting review), so current-world impact is
  zero; a backfill migration would need a product decision about detecting "still has the
  broken shape" vs. "tenant customized it," not just a mechanical fix.
- **No backfill for `entity_fields` rows already stuck at `sensitivity = 'internal'`** from
  the `addEntityField` bug (fixed above, going forward only) — same reasoning: which existing
  fields were *meant* to be `pii`/`financial` isn't mechanically knowable, needs a tenant/
  product decision, not an automated fix.

### Verification (CI-equivalent local run, same method as PR #135)

- pnpm typecheck: PASS
- pnpm lint: N/A — discovered `pnpm lint` (`turbo run lint`) is a pre-existing repo-wide
  no-op: no package.json anywhere defines a `lint` script, so `turbo run lint` matches
  nothing and trivially succeeds. Confirmed by running `npx eslint` directly on the repo
  root (found real pre-existing errors in untouched files) and then scoped to just this
  PR's changed files (zero errors/warnings). Worth a follow-up issue — flagging, not fixing,
  since it's unrelated to #126 and affects the whole repo/CI, not just this change.
- pnpm test: PASS (327/327, up from 321)
- pnpm test:isolation: PASS (118/118, up from 112 — the new entity-created/entity-assigned
  trigger tests, split across two files)

### Next

1. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
2. Doc fixes from the review: `roadmap-tracker.md` Phase 2 gate wording, `platform-vision.md`
   Mermaid diagram, ADR-004 reference — already shipped in PR #137 (awaiting team merge
   approval as of this session)
3. Remaining hardening items #120, #123, #124, #125, #128, #129
4. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions`
5. New: file a follow-up issue for the `pnpm lint` no-op discovered above

### Open questions

- None blocking on #126 itself. Flagging for awareness: `bulkCreateEntities`/
  `bulkUpdateEntities` now emit outbox events per existing helpdesk-seed-style rules — any
  tenant that already has module seeds installed will see previously-silent automations
  start firing on the next deploy (not a bug, a behavior change worth a changelog note,
  same category as the entity.created note in the original consulting review).

---

## 2026-07-08 — Post-PR #137 cleanup

### Done

- Fixed two cosmetic residuals flagged in PR #137 review:
  - `docs/reviews/2026-06-29-consulting-review.md` §6 item 12 struck through — finding
    was retracted in §2 (no field type discrepancy exists); open action item was misleading.
  - `docs/sup-docs/week-log.md` 2026-07-08 entry corrected — ADR-004 is now second in the
    CLAUDE.md reference list (not "first"), description uses the softened wording.
- `docs/sup-docs/roadmap-tracker.md` last-updated line updated to include PR #137.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

1. #126 — emit `entity.created` / `entity.assigned` to the outbox (core function, currently dead automations)
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Remaining hardening items #120, #123, #124, #125, #128, #129

### Open questions

- None blocking.

---

## 2026-07-07 — Hardening #121 / #122: RLS role enforcement

### Done

- `packages/db/src/middleware.ts`: `withTenantContext` now issues `SET LOCAL ROLE app_user`
  before setting the `app.tenant_id` GUC, mirroring `withTenantAndUserContext`. Closes #121.
- `packages/db/src/client.ts`: same fix in `executeRawInTenantContext` (used by module seed SQL).
- `packages/db/migrations/0022_app_user_rls_grants.sql`: grants `app_user` the
  `INSERT/UPDATE/DELETE` it was missing on `entity_types`, `workflows`, `workflow_states`,
  `workflow_transitions` (previously SELECT-only), and `UPDATE` on `tenants` — required
  because workflow-state/transition CRUD, module install/uninstall, and module seed SQL all
  route through `withTenantContext`/`executeRawInTenantContext` and would otherwise start
  failing with permission-denied the moment the role switch landed.
- Un-skipped the three cross-tenant RLS assertions (#122): `entity-engine.isolation.test.ts`,
  `workflow-engine.isolation.test.ts`, and `automation-engine.isolation.test.ts` (this last
  one had no assertion at all — wrote a real direct-SELECT-via-RLS test for it, using
  `withTenantContext` + a query with no explicit tenant filter, matching the other two files).
- Updated `.claude/rules/db-conventions.md` and `.claude/rules/security.md` to describe the
  new role-switch behavior instead of the stale "RLS is bypassed" warning.
- Branch: `fix/PLAT-121-rls-role`. Plan-lock approved by human before any source edit.

### /code-review + /security-review findings (fixed before shipping)

Security review: no findings (traced every call site touching newly-granted tables; all
tenant-scoped writes are JWT-derived and gated by pre-existing ownership checks).

Correctness review surfaced two real bugs, both fixed:

- **`apps/worker/src/tenant-purge.ts:154`** deletes from `dead_letter_events` inside
  `withTenantContext`, but `app_user` only had SELECT+INSERT on that table (migration 0019)
  — the role switch would have broken tenant purge/GDPR deletion with permission-denied for
  any tenant with a dead-lettered job. Added `GRANT DELETE ON dead_letter_events TO app_user`
  to migration 0022.
- **`automation-engine.isolation.test.ts`**'s un-skipped RLS test never seeded a Tenant B
  `automation_executions` row, so it passed vacuously regardless of whether RLS worked.
  Added a `beforeAll` that creates a real Tenant B execution via `executeAutomationRules`,
  plus a sanity-check test proving the row exists (via superuser query) before the RLS test
  proves it's invisible from Tenant A's context.

Also fixed two lower-severity findings: `security.md` pointed only to migration 0019 for
`app_user`'s grants (now also references 0022), and 0022's DOWN MIGRATION block was buried
after 20 lines of rationale instead of near the top like every sibling migration.

Declined one cleanup suggestion: dedup the `SET LOCAL ROLE app_user` line across 3 call
sites into a shared helper — CLAUDE.md's code-style guidance favors 3 similar 2-line blocks
over a premature abstraction, and it matches the file's pre-existing pattern.

Re-ran the full exit condition after fixes: typecheck/lint/test/test:isolation all still
green (see Verification below, numbers reflect the post-fix state).

### New finding — filed as [#136](../../issues/136), not fixed in this PR

`entity_types` and `workflows` have a nullable `tenant_id` but **no RLS policy at all**
(`NULL` tenant_id = system/template rows visible to every tenant); `workflow_states` /
`workflow_transitions` have no `tenant_id` column at all — isolation there depends entirely
on the explicit ownership checks in `packages/workflow-engine` (`assertWorkflowOwned`,
`visibleTo`). This was already true before this PR (RLS was bypassed everywhere via the
superuser connection) — the grant migration does not change or worsen it, since GRANTs are
table-level, not row-level. But it means these four tables have zero second line of defense.
Needs a design decision (schema change) before Phase 3 — tracked in #136.

### Human PR review round (PR #135, reviewed by @PrabhuVijit) — all addressed

PR approved with 2 medium + 3 low non-blocking items; user asked to fix all of them in this
PR rather than defer, since none required large changes:

- **SEC-1** (medium): `GRANT UPDATE ON tenants` was table-wide; column-scoped to
  `GRANT UPDATE (config, updated_at) ON tenants TO app_user` — the only columns the
  module-install/uninstall call site writes. Amended migration 0022 directly (pre-merge,
  never applied to a real environment).
- **TEST-1** (medium): fixing the vacuous-test bug (see above) had removed the only
  assertion that Tenant A's `executeAutomationRules` run doesn't write execution rows
  attributed to Tenant B's rule (the engine-level `WHERE tenant_id` guard, distinct from
  the RLS layer). Restored it as a new test scoped by `ruleId = ruleIdB AND tenantId =
  TENANT_A`.
- **DOCS-1** (low): fixed a markdown line-wrap in `security.md` where prettier had broken
  a sentence mid-backtick-phrase (`` `SET LOCAL ROLE\napp_user` `` at column 0).
- **SUGG-1** (low): filed #136 for the no-RLS tracking issue instead of leaving it as a
  PROGRESS.md note.
- **SUGG-2** (low): added a comment in `executeRawInTenantContext` pointing future module-
  seed authors at the 0022 grant pattern if they hit `permission denied for table X`.

### Verification (CI-equivalent local run — see note below)

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (321/321 — up from 320: the automation-engine isolation suite grew from
  8 real + 1 no-op skip → 9 real assertions after the initial fix, then +1 more restoring
  the engine-layer WHERE test from the PR review round)
- pnpm test:isolation: PASS (112/112, all three previously-`.skip`'d RLS assertions run for
  real and pass, plus the restored engine-layer assertion)

**How verification was run:** OrbStack was not running at session start. The repo's own
`docker-compose.yml` `postgres` service couldn't bind port 5432 because a pre-existing,
unrelated container (`platform-postgres-1`, same repo directory but an older compose
project name, still running from a prior session) already held it — left untouched, not
part of this PR. Instead of reusing that dev container (which has broader ambient app_user
grants from `docker/postgres/init/001_setup.sql`'s `ALTER DEFAULT PRIVILEGES`, masking any
CI-only grant gaps), spun up plain `postgres:16-alpine` + `redis:7-alpine` containers on
ports 5433/6379 matching `.github/workflows/ci.yml` exactly (same `platform` superuser,
same `platform_test` DB, no init script) so the grant migration was validated against the
same conditions as the real CI gate. Removed both temp containers after the run.

### Next

Per the consulting review (`docs/reviews/2026-06-29-consulting-review.md`) and the
hardening checklist in CLAUDE.md, in order:

1. #126 — emit `entity.created` / `entity.assigned` to the outbox (core function, currently
   dead automations)
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Doc fixes from the review: `roadmap-tracker.md` Phase 2 gate wording, `platform-vision.md`
   Mermaid diagram, ADR-004 added to CLAUDE.md reference list
4. Remaining hardening items #120, #123, #124, #125, #128, #129
5. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions` (filed during PR #135 review)

### Open questions

- None blocking.
