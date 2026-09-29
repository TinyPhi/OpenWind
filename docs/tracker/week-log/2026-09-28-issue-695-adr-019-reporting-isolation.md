## 2026-09-28 — #695 ADR-019 (3G reporting tenant isolation)

**Session type:** Docs, ADR authoring (human-directed)
**Issue:** #695
**PR:** #707
**Branch:** `docs/PLAT-695-adr-019-reporting-isolation`

### Done

- **ADR-019 drafted, `Status: Proposed`.** Records the 3G isolation design that Stages 1–2
  already ship (#663–#671, migrations 0112–0124). It covers: `DB_CONNECTION_MUTATOR` stamping
  `app.tenant_id` so platform RLS applies to Superset; fail-closed on a missing tenant; the
  guest-token row filter as a second layer only; least-privilege grants and payload exclusion;
  the restrictive own-rows policy; audit through `record_reporting_audit()`; 60 s embed passes;
  Zitadel-derived tenant for Stage 2. Left at `Proposed` so acceptance is a separate human step
  (the gap #471 flagged for ADR-012).
- `CLAUDE.md`: ADR-019 added to "Read before touching"; 3G headline updated.
- `roadmap-tracker.md`: 3G row, the #695 Open Tickets row, and the Summary line that still said
  the isolation ADR was unwritten.
- The ADR-008/009/011 `sup-docs` citation fixes first drafted here landed on `main` through #702,
  so they dropped out of this PR on rebase.

### Review round 1 (2026-09-29, @abmish and @PrabhuVijit, changes requested)

- **Stage 2 is pending a private security review.** ADR-019 now says Stage 2 must stay disabled
  (`SUPERSET_OAUTH_CLIENT_ID` unset) on every deployment until it closes, drops the "a
  user-written query cannot widen what a user sees" claim, and adds OQ-6. Decisions 2 and 6 record
  the outcome once the review closes.
- **SQL Lab 0-row result explained.** Round 0 left it open. A clean diagnostic probe (throwaway
  user, deleted afterwards) reproduced it: the same count returns the tenant's 306 through a chart
  and 0 through SQL Lab, and the cause is in how Superset runs SQL Lab queries rather than in the
  test harness. It fails closed. It is covered by the private Stage 2 review (OQ-6) and does not
  affect Stage 1.
- Added from review: audit gap tracked as #709 and recorded as best-effort (fail-open) with a
  Deferred row; PgBouncer refuses the startup option outright (re-checked on the local
  PgBouncer 1.25.2: `FATAL: unsupported startup parameter in options: app.tenant_id`); the
  init-script bootstrap window (#708); views must stay `security_invoker` because no reporting
  table forces RLS; the connection mutator has no test; `_TENANT_ID_RE` / `_PRINCIPAL_ID_RE`
  cited and confirmed anchored; the "unusable binding" behaviour spelled out; OQ-3 names
  ADR-015 and the 300 s Redis cache gap; next step 2 points at #702, which fixed ADR-001.

### Review round 2 (2026-09-29, @PrabhuVijit)

- OQ-6 now points at #716 for the SQL Lab 0-row result: SQL Lab runs queries outside the user's
  login context, so no tenant is stamped and RLS returns nothing (fails closed). Stage 1 has no
  SQL Lab and is unaffected.

### Found along the way

- **#695 asked to ratify "option C" (redact on write into a stored column). That is not what
  shipped.** It was superseded on 2026-09-21 by `docs/specs/reporting-metadata-masking-repair.md`:
  payload columns are withheld by grant, and charts read trigger-maintained mirrors. ADR-019
  records exclusion and names option C as superseded. The 3G tracker row said option C and is
  corrected here.
- **Stage 2 export works, and Superset-side audit never fires. Verified live** against the local
  `ow-superset` (6.1.0) with a throwaway `ReportingAnalyst` + tenant-role user, deleted
  afterwards:
  - chart CSV (`/api/v1/chart/<id>/data/?format=csv`) → 200 through `can_csv`;
  - SQL Lab streaming export (`/api/v1/sqllab/export_streaming/`) → 200 `text/csv`, through
    `can_read` on SQLLab (the endpoint declares `@permission_name("read")`);
  - control: plain SQL Lab export (`can_export_csv`, withheld) → 403;
  - `admin_audit_log` gained no `reporting.*` row. Superset logged `ChartDataRestApi.data`,
    `SqlLabRestApi.get_results` and `SqlLabRestApi.export_streaming_csv`, none of which are in
    `PlatformAuditEventLogger`'s map (`sql_json`, `csv`, `export_csv`, …).

  Export itself is accepted: no issue forbids it, and the standalone spec's R7 treats it as a
  capability to bound and audit, not withhold. The audit gap is a real defect (#709).

### Deliberately not done

- Stale wording in the 3G specs (option C, audit names, the 404, the "ungranted" export status)
  and the `docker/superset/bootstrap.py:370` comment: a separate follow-up PR after this merges,
  so this one stays docs-only (agreed on #707).
- 3H module-ownership (#622) and ticket-relations (#620) ADRs: drafted in #702.

### Verification

- Every fact in ADR-019 checked against source (migrations, `superset_config.py`, `bootstrap.py`,
  `superset-client.ts`, `guest-token.ts`, `docker-compose.yml`), not the specs alone.
- Prettier, commitlint and `check-contribution-guardrails.sh` clean.
