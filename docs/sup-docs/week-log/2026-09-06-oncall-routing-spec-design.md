## 2026-09-06 — On-call routing & severity-based notification dispatch: spec + design

**Session type:** Feature planning — spec + design documents (no implementation yet)
**Branch:** `docs/oncall-routing-spec`

### Context

Product direction: replace ad-hoc ticket assignment with team-level routing backed by an
on-call roster scheduler. When an agent doesn't know the right owner they assign to a team
and service; the system resolves who is on-call for that team and assigns automatically. A
separate but related concern — notifications are severity-blind today — was scoped into the
same feature: severity drives a configurable channel mix (email / SMS / WhatsApp / voice call)
configurable per team, workflow type, and severity level.

### What was produced

**`docs/specs/oncall-routing.md`** — Full requirements spec (§G, §C, §I, §R, §V, §T).
33 tasks across 4 phases:

- Phase 1 (DB): `teams`, `services`, `on_call_schedules`, `notification_policies` migrations +
  RLS + analytics annotations; `admin_audit_log` CHECK constraint extensions; ticket entity
  type system-field seeds
- Phase 2 (API): CRUD routes for all four new entities; on-call current-snapshot endpoint;
  notification policy resolve dry-run endpoint; cross-tenant isolation tests
- Phase 3 (Automation): `resolve_oncall` + `dispatch_severity_notification` action types;
  system-seeded automation rules; idempotency + explicit-assignee-wins guards; backup on-call
  notification; cross-tenant dispatch isolation tests
- Phase 4 (UI): Teams/services admin pages; roster calendar builder; notification policy matrix
  builder with preview; coverage-gap ticket badge; ticket form (severity, tags, team, service)

**`docs/oncall-routing-design.md`** — Detailed design reference covering: full SQL schema for
all four new tables (including the GIST exclusion constraint on `on_call_schedules`), complete
API request/response shapes for every endpoint, exact algorithm pseudocode for both automation
actions (resolve_oncall and dispatch_severity_notification), security model table, ASCII
sequence diagrams for both main flows, new environment variables, migration sequence (0090–
0095), and testing checklist.

**`docs/specs/adr-016-draft-oncall-routing.md`** — ADR draft covering the six key decisions:
teams/services as own tables (not entity types), GIST-constrained schedule windows, four
system ticket fields via entity engine, two new automation action types, specificity-scored
notification policies, and new channels through Novu (no new package). Includes consequences,
deferred decisions, and open questions. **To be moved to `docs/decisions/ADR-016-*.md` by a
human after review** — per this repo's authorship rule.

### Key design decisions (summary)

| Decision                                    | Choice                      | Rationale                                                                                                                                              |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Teams as own table vs entity type           | Own table                   | On-call lookup is a hot path; JSONB traversal + schema-cache overhead is unacceptable; FK integrity for schedule overlap prevention requires a real FK |
| Overlap prevention                          | GIST exclusion constraint   | Correctness at DB layer, not just application layer — same philosophy as the pessimistic-lock on workflow transitions                                  |
| Notification channel selection              | Specificity-scored policies | Most-specific match wins; fallback chain prevents a "no config = no notification" gap; additive (existing behaviour unchanged if no policies exist)    |
| New channels (SMS/WhatsApp/call)            | Novu provider configs       | `@platform/notifications` already wraps Novu; new channels are ops config, not new code                                                                |
| Channel failure handling                    | Isolated per channel        | ADR-014 precedent: a channel failure never rolls back the ticket write; each failure audited individually                                              |
| Explicit assignee + team_id on same request | Explicit wins               | Prevents auto-routing from overriding deliberate assignment; audited                                                                                   |

### No implementation in this session

This session is docs/planning only — no source code touched. Phase 1 implementation begins
after the ADR draft is reviewed and the human opens GitHub issues for each phase.

### Open questions for human decision

- **OQ-1 (ADR):** Should services have their own on-call schedule independent of their owning
  team? (v1 spec says no; services inherit routing from team)
- **OQ-2 (ADR):** Should `tags` be free-text or require a managed tenant vocabulary? (v1: free-text)
- **OQ-3 (ADR):** Should `dispatch_severity_notification` fire on initial ticket creation if
  severity is set at create time? (v1 spec: yes — severity set from null is treated the same
  as a severity change)

### Verification

- `pnpm typecheck`: N/A — docs-only session
- `pnpm lint`: N/A
- `pnpm test`: N/A
