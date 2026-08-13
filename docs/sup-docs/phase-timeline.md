# Phase Development Timeline — AI-First Team

**Team model:** Small AI-first team. Claude Code handles implementation; humans drive architecture
decisions, reviews, and product judgment.
**For current phase/track status:** see [roadmap-tracker.md](roadmap-tracker.md) — this file no
longer tracks dates or % complete. Its original week-by-week projection (written 2026-05-22)
was blown by Week 8 (Phase 2 hardening ran ~7 weeks past the projected exit, and Phase 3's
projected 2026-07-07 start has not happened as of 2026-07-24 — Phase 3 remains "not started,
planning required" per `CLAUDE.md`). Kept here only for the parts that are still true: the
velocity baseline, the operating model, and the config-first test.

---

## Velocity baseline (from Phase 1)

| Metric               | Value                                           |
| -------------------- | ----------------------------------------------- |
| Phase 1 duration     | ~7 active days (2026-05-14 to 2026-05-21)       |
| PRs merged           | 17 PRs                                          |
| Issues closed        | 20+ issues                                      |
| PRs/day              | ~2.4                                            |
| Engine lines shipped | ~4,000 (entity + workflow + automation engines) |
| Test coverage        | ≥80% core, full isolation suite                 |

**Key insight:** Config-first architecture front-loaded the hard work into Phase 1. Phase 2
modules are seed SQL + UI wiring — this held: module seed work was consistently lower-risk per
change than engine work, though total elapsed time for Phase 2 (including hardening) ran far
longer than the original projection below ever assumed.

---

## AI-first team operating model

**Each feature track follows this pattern:**

1. **Spec session**: describe the track, reference the ADR and existing code, identify edge cases
2. **Generation pass**: Claude Code implements with tests in one session
3. **Review pass**: human reviews output, security check, `gh pr create`
4. **`/ultrareview` pass**: multi-agent cloud review on the PR before merge
5. **Log session**: add a new file under [week-log/](week-log/) and update your track's own row
   in [roadmap-tracker.md](roadmap-tracker.md)

**Where humans must stay in the loop:**

- Architecture decisions (write an ADR, don't just code)
- Security-sensitive routes (auth, tenant isolation, file access)
- Pilot customer interactions and onboarding
- Phase exit decisions (don't advance phases without explicit sign-off)

**Totem: the config-first test**
Before shipping any new module feature, ask: did this require any TypeScript changes outside of
`packages/*` or `apps/*`? If yes, something has gone wrong. Seed SQL only.

---

## Original projection (2026-05-22, superseded — kept for historical comparison only)

Written the day after Phase 1 closed. Projected Phase 2 as a 6-week, calendar-dated plan and
Phase 3 as starting 2026-07-07. Neither held: Phase 2's hardening tail alone ran through
2026-07-24, and Phase 3 has not started. Not maintained since — do not use for current status.

```
Week 1-2   May 13–24    Phase 1 complete ✅
Week 3-8   May 25–Jul 5 Phase 2 (projected — actual ran substantially longer, see below)
           Jul 6        Pilot customer onboarding gate (pen test required) — projected, not actual
Week 9+    Jul 7+       Phase 3 begins — projected, not actual (still not started as of 2026-07-24)
```

**What actually took the extra time:** a pre-Phase-3 hardening backlog (issues #120–#129, plus
follow-ons #136/#141/#143/#160/#167/#168/#170/#171) that wasn't anticipated in the original
projection — surfaced by an external consulting review partway through Phase 2, not scoped up
front. See [roadmap-tracker.md](roadmap-tracker.md) for what's still open.
