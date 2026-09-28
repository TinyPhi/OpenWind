## 2026-09-28 — #695 ADR-019 (3G reporting tenant isolation) + stale ADR citations

**Session type:** Docs, ADR authoring (human-directed)
**Issue:** #695
**Branch:** `docs/PLAT-695-adr-019-reporting-isolation`

### Done

- **ADR-019 drafted, `Status: Proposed`.** Records the 3G isolation design that Stages 1–2
  already ship (#663–#671, migrations 0112–0124). It covers: `DB_CONNECTION_MUTATOR` stamping
  `app.tenant_id` so platform RLS applies to Superset; fail-closed on a missing tenant; the
  guest-token row filter as a second layer only; least-privilege grants and payload exclusion;
  the restrictive own-rows policy; audit through `record_reporting_audit()`; 60 s embed passes;
  Zitadel-derived tenant for Stage 2. Left at `Proposed` so acceptance is a separate human step
  (the gap #471 flagged for ADR-012).
- **Stale citations fixed** in ADR-008 (lines 111, 207), ADR-009 (292) and ADR-011 (213):
  `docs/sup-docs/…` → `docs/tracker/…`. Path-only change; the cited text was not reworded.
- `CLAUDE.md`: ADR-019 added to "Read before touching"; 3G headline updated.
- `roadmap-tracker.md`: 3G row and the #695 Open Tickets row only (Summary scorecard left for
  reconciliation, per that doc's convention).

### Found along the way

- **#695 asked to ratify "option C" (redact on write into a stored column). That is not what
  shipped.** It was superseded on 2026-09-21 by `docs/specs/reporting-metadata-masking-repair.md`:
  payload columns are withheld by grant, and charts read trigger-maintained mirrors. ADR-019
  records exclusion and names option C as superseded. The 3G tracker row said option C and is
  corrected here.
- **Stage 2 export is open, and Superset-side audit never fires. Verified live** against the local
  `ow-superset` (6.1.0) with a throwaway `ReportingAnalyst` + tenant-role user, which was deleted
  afterwards:
  - chart CSV (`/api/v1/chart/<id>/data/?format=csv`) → 200 with the tenant's real count,
    through `can_csv`;
  - SQL Lab streaming export (`/api/v1/sqllab/export_streaming/`) → 200 `text/csv`, through
    `can_read` on SQLLab (the endpoint declares `@permission_name("read")`);
  - control: plain SQL Lab export (`can_export_csv`, withheld) → 403;
  - `admin_audit_log` gained no `reporting.*` row. Superset logged `ChartDataRestApi.data`,
    `SqlLabRestApi.get_results` and `SqlLabRestApi.export_streaming_csv`, none of which are in
    `PlatformAuditEventLogger`'s map (`sql_json`, `csv`, `export_csv`, …).

  Export itself is accepted: no issue forbids it, and the standalone spec's R7 treats it as a
  capability to bound and audit, not withhold (its "deliberately ungranted pending T12" status
  line is out of date). The audit gap is a real defect — T11 is marked done but writes nothing —
  and its fix is code, so it goes in its own issue. Both recorded in ADR-019 (Decision 7 shipped
  gap, Negative and mitigations, OQ-1 resolved).

- Unexplained, not chased: in the same in-process probe, SQL Lab returned 0 rows while the chart
  path returned the tenant's 306. As `analytics_user` directly, a stamped session sees 306. This
  may be the test harness rather than production behaviour; worth one manual SQL Lab check.
- ADR-001's database-user table still lists `analytics_user` as "SELECT + BYPASSRLS … Metabase";
  0112 made it `NOBYPASSRLS`. Flagged in ADR-019's next steps, not edited here.
- `docs/specs/superset-embedded-dashboarding.md` §V / T3 / T3b / T3c / T12 still describe option C.

### Deliberately not done

- 3H module-ownership ADR (#622) and ticket-relations ADR (#620): separate PRs under #695.
  ADR-018 stays reserved for 3C; these take the next free numbers.

### Verification

- Every fact in ADR-019 checked against `upstream/main` source (migrations, `superset_config.py`,
  `bootstrap.py`, `superset-client.ts`, `guest-token.ts`, `docker-compose.yml`), not the specs alone.
- `git grep sup-docs -- docs/decisions/` returns nothing.
- Prettier check clean on touched files.
