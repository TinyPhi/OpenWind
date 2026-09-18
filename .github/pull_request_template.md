## Summary

<!-- What does this PR do, and why? Link the issue it closes if there is one. -->

Closes #

## Type of change

- [ ] Feature
- [ ] Fix
- [ ] Chore / refactor
- [ ] Docs
- [ ] Test

## Checklist

- [ ] Tests included — coverage does not drop (or `[skip-tests-check]` in the PR title with a
      one-line reason, per `.claude/rules/git-conventions.md`)
- [ ] `pnpm typecheck` and `pnpm lint` pass with zero errors
- [ ] Follows [Conventional Commits](https://www.conventionalcommits.org/)

**If this PR touches `packages/db/` or adds tables:**

- [ ] `tenant_id UUID NOT NULL` on all new tenant-scoped tables
- [ ] RLS enabled + both read and write policies defined
- [ ] Tenant isolation tests added (`tests/isolation/`) — or `[skip-isolation-check]` with a reason
- [ ] Analytics annotation on every new `CREATE TABLE`

**If this PR touches `apps/api/` or adds routes:**

- [ ] All inputs validated with Zod at the route boundary
- [ ] `requireAuth()` applied
- [ ] Rate limiting configured

**If this PR makes a significant architectural decision:**

- [ ] ADR created or updated in `docs/decisions/` (ADRs are human-authored, per `CLAUDE.md`)
