## 2026-09-07 — Temporal Scheduler: spec + design

**Session type:** Feature planning — spec + design documents (no implementation yet)
**Branch:** `docs/temporal-scheduler-spec`

### Context

Platform need: recurring workflows (monthly leadership review, weekly standup, quarterly
compliance check) require someone to manually create the ticket at the right time. When that
person forgets, workflows start late or not at all. The temporal scheduler eliminates the
manual step — an admin configures a rule once and the platform creates the ticket automatically
at the scheduled time, fully configured and assigned.

### What was produced

**`docs/specs/temporal-scheduler.md`** — Full requirements spec (§G, §C, §I, §R, §V, §T).
17 tasks across 4 phases:

- Phase 1 (DB): `schedule_rules` + `schedule_executions` migrations + audit log extension
- Phase 2 (API): CRUD routes, execution history endpoint, next-fires dry-run endpoint, isolation tests
- Phase 3 (Worker): scheduler tick, catch-up logic, Prometheus metrics, OTel spans, worker integration + isolation tests
- Phase 4 (UI): schedule rule builder, execution history table, next-fires preview panel

**`docs/temporal-scheduler-design.md`** — Detailed design reference covering: full SQL schema for
both new tables (RLS read/write pairs, partial unique indexes, due-rules index), template Zod
schema with cross-tenant validation, full worker tick algorithm pseudocode (`processRule`,
`handleCatchUp`, `renderTemplate`, `computeNextFireAt`, `classifyScheduleError`), API request/
response shapes for all endpoints, security model table, sequence diagrams, environment variables,
migration sequence (0098–0100), full test coverage spec (§8), observability & telemetry (§9).

**`docs/specs/adr-017-draft-temporal-scheduler.md`** — ADR draft covering 6 key decisions:
DB-polling vs BullMQ repeatable jobs, cron as canonical format, closed-whitelist `{{variable}}`
templating, skip-by-default missed fires with optional catch-up (capped at 24), ticket
attributed to rule's creator, fire-time re-validation. Includes consequences, deferred decisions,
3 open questions.

### Key design decisions (summary)

| Decision             | Choice                                     | Rationale                                                                                            |
| -------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Execution engine     | DB polling (SELECT FOR UPDATE SKIP LOCKED) | Consistent with SLA scheduler; no Redis state sync risk; exactly-once across worker instances        |
| Schedule format      | 5-field cron expression                    | Handles all recurrence patterns including nth-weekday-of-month; one canonical format in DB           |
| Title templating     | Closed-whitelist `{{variable}}`            | Zero SSTI risk; no template engine; unknown tokens pass through as literals                          |
| Missed fire handling | Skip by default; catch-up optional (≤ 24)  | Recurring workflow tickets are date-contextual; creating stale tickets is often worse than no ticket |
| Ticket attribution   | Rule's creator (`created_by`)              | Audit-traceable; avoids synthetic system identity complexity                                         |
| Template validation  | At write time + at fire time               | Schema can change between rule creation and fire; fire-time check is the safety net                  |

### Migration sequence

| Migration | Contents                                                |
| --------- | ------------------------------------------------------- |
| `0098`    | `schedule_rules` table + RLS + indexes                  |
| `0099`    | `schedule_executions` table + RLS + indexes             |
| `0100`    | Extend `admin_audit_log` CHECK for `schedule.*` strings |

Note: migrations 0092–0097 are claimed by the on-call routing spec (3E Phase 1, issue #565).
Temporal scheduler starts at 0098.

### Open questions for human decision

- **OQ-1:** Should admins be able to override `created_by` with a dedicated `system_user_id` to decouple rule execution from creator account status?
- **OQ-2:** Should 3 consecutive failed executions auto-pause the rule and notify the admin?
- **OQ-3:** Should next-fires preview be inline in `GET /admin/schedule-rules` or require a separate request per rule?

### No implementation in this session

Docs/planning only — no source code touched. Phase 1 implementation begins after the ADR
draft is reviewed and GitHub issues are opened for each phase.

### Verification

- `pnpm typecheck`: N/A — docs-only session
- `pnpm lint`: N/A
- `pnpm test`: N/A
- `pnpm test:isolation`: N/A
