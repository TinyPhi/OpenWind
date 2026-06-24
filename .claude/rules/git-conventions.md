# Git Conventions — OpenWind Platform

---

## Branch naming

```
feat/PLAT-123-add-module-registry
fix/PLAT-456-sla-timer-not-cancelling
chore/PLAT-789-upgrade-drizzle
docs/PLAT-012-adr-002-workflow-engine
test/PLAT-345-isolation-tests-audit-log
```

---

## Commit messages (Conventional Commits)

```
feat(db): add module_registry table and seed runner
feat(modules): helpdesk seed — ticket workflow + SLA automation
fix(workflow): cancel SLA timer on terminal transition
test(isolation): add RLS tests for module-seeded entity types
chore(deps): upgrade hono to 4.x
docs(adr): record decision on field validation strategy
```

Scope = the package or area changed. Message describes the effect, not the mechanism.

---

## Parallel agent worktrees

When running multiple agents simultaneously against this codebase, each agent needs
its own git worktree to avoid conflicting writes:

```bash
# Create a worktree for a specific fix branch
git worktree add ../openwind-fix-121 fix/PLAT-121-rls-role

# List active worktrees
git worktree list

# Remove when done
git worktree remove ../openwind-fix-121
```

**Naming convention:** `../openwind-<type>-<issue>` for issue-driven work,
`../openwind-<agent-name>` for open-ended agent sessions.

Each agent reads and writes only its own worktree. Write status back to
`PROGRESS.md` in the main worktree so the verifier has a unified view.

---

## PR checklist

- [ ] Tests included (coverage does not drop)
- [ ] Isolation tests added/updated if new tables or routes added
- [ ] ADR updated or created for significant architectural decisions
- [ ] `CHANGELOG.md` entry for user-facing changes
- [ ] No `any` types introduced
- [ ] No direct `process.env` reads introduced
- [ ] RLS policy on all new tenant-scoped tables
- [ ] Explicit `WHERE tenant_id = ?` filter in every engine query touching the new table
- [ ] Analytics annotation on every new `CREATE TABLE`
      (`-- analytics: excluded (reason)` or `-- analytics: included(col1,col2,...)`)
- [ ] `/ultrareview` passed before merge
- [ ] `/security-review` passed if PR touches auth, new tables, routes, file access, or secrets
