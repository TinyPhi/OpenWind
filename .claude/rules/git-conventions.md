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

## PR checklist

- [ ] Tests included (coverage does not drop)
- [ ] Isolation tests added/updated if new tables or routes added
- [ ] ADR updated or created for significant architectural decisions
- [ ] `CHANGELOG.md` entry for user-facing changes
- [ ] No `any` types introduced
- [ ] No direct `process.env` reads introduced
- [ ] RLS policy on all new tenant-scoped tables
- [ ] Analytics annotation on every new `CREATE TABLE`
      (`-- analytics: excluded (reason)` or `-- analytics: included(col1,col2,...)`)
- [ ] `/ultrareview` passed before merge
- [ ] `/security-review` passed if PR touches auth, new tables, routes, file access, or secrets
